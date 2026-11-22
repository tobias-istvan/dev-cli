import { withRefresh } from "../core/refresh.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import type { ChangeRequest, Output, Reference, ServiceEntry, TaskContext, TaskItem } from "../plugins/types.ts";
import { workspaceServiceContext } from "../core/context.ts";
import { DevError } from "../core/output.ts";
import { count, step } from "../core/progress.ts";
import { loadConfig, type ProjectConfig } from "../core/project-config.ts";
import { enabledServices } from "../core/scaffold.ts";
import { basesFor, legacyTaskId, taskDir, taskId, workspaceBase, writeTaskNotes } from "../core/tasks.ts";
import { git, gitMaybe } from "../core/git.ts";
import {
  baseRef,
  branchName,
  copyLocalFiles,
  DEFAULT_BRANCH_PATTERN,
  ensureWorktree,
  fetchRemote,
  inspectWorktree,
  inspectWorktrees,
  isMergedAt,
  isSafeToRemove,
  removeWorktree,
  requireClone,
  slugify,
  worktreeDir,
  worktreeIds,
  type WorktreeState,
} from "../core/worktree.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";
import { describeRecord, readRecord, recordNotes } from "../core/task-record.ts";
import { findTaskPr, readBrief, setBriefFields, startNextRound } from "../core/rounds.ts";
import { today } from "../core/day.ts";

export interface StartOptions {
  title?: string;
  type?: string;
  base?: string;
}

/** The first enabled service that recognises the whole reference, with what it knows. */
async function resolve(root: string, config: ProjectConfig, registry: Registry, ref: string, out: Output): Promise<{ entry: ServiceEntry; reference: Reference; context: TaskContext } | null> {
  const entries = enabledServices(config, registry);
  const candidates: Array<{ entry: ServiceEntry; reference: Reference; local?: TaskItem }> = [];
  for (const entry of entries) {
    const prefix = `${entry.service.id}:`;
    const word = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
    const context = workspaceServiceContext(root, entry, config, registry, out);
    const numeric = /^#?\d+$/.test(word) && config.versioning?.service.split(":")[0] === entry.plugin.name;
    const expanded = numeric ? `${config.versioning!.repo}#${word.replace("#", "")}` : word;
    const reference = entry.service.links?.find(expanded, context).find((r) => r.id === expanded || r.url === expanded);
    if (reference) candidates.push({ entry, reference });
    else if (entry.service.tasks) {
      for (const local of await entry.service.tasks.list(context)) {
        if (local.id === word) candidates.push({ entry, reference: { id: local.id, service: entry.key }, local });
      }
    }
  }
  const explicit = candidates.filter((candidate) => ref.startsWith(`${candidate.entry.service.id}:`));
  const choices = explicit.length ? explicit : candidates;
  const providers = new Set(choices.map((candidate) => candidate.entry.plugin.name));
  if (providers.size > 1) throw new DevError("That reference matches several services.", "Prefix it with the service, like github-issues:owner/repo#42.");
  if (!choices.length) return null;
  const chosen = choices.find((candidate) => candidate.entry.service.links) ?? choices[0]!;
  const { entry, reference, local } = chosen;
  const context = workspaceServiceContext(root, entry, config, registry, out);
  const links = entry.service.links;
  if (local && !links) {
    const files = choices.flatMap((candidate) => candidate.local ? [candidate.local.file] : []);
    const text = await (await import("node:fs/promises")).readFile(path.join(root, local.file), "utf8");
    const notFetched: string[] = [];
    for (const found of await context.references(text)) {
      if (found.file) files.push(found.file);
      else if (found.outside) notFetched.push(found.reference.url ?? found.reference.id);
    }
    return { entry, reference, context: { title: local.title, files, references: [], notFetched } };
  }
  if (!links) return null;
  const task = await step(out, `Fetching ${reference.id} from ${entry.service.title}`, async (progress) => {
    const file = await links.fetch({ ...context, progress }, reference);
    return entry.service.contribute?.taskStart
      ? await entry.service.contribute.taskStart({ ...context, progress }, reference)
      : { title: reference.id, files: [path.relative(root, file!)], references: [] as Reference[] };
  });

  // One step further: what the item links to, like a parent's spec.
  if (task.references.length > 0) {
    await step(out, `Fetching what ${reference.id} links to`, async (report) => {
      for (const [i, next] of task.references.entries()) {
        report(`${i} of ${count(task.references.length, "link")}: ${next.id}`);
        const owner = enabledServices(config, registry).find((e) => e.key === next.service);
        if (!owner?.service.links) continue;
        try {
          task.files.push(path.relative(root, await owner.service.links.fetch(workspaceServiceContext(root, owner, config, registry, out), next)));
        } catch (error) {
          out.warn(`Couldn't fetch ${next.id} from ${owner.service.title}: ${(error as Error).message}`);
        }
      }
    });
  }
  task.files.push(...choices.flatMap((candidate) => candidate.local ? [candidate.local.file] : []));
  return { entry, reference, context: task };
}

export async function runTaskStart(registry: Registry, out: Output, ref: string, options: StartOptions): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const repo = requireClone(root);

  const resolved = await resolve(root, config, registry, ref, out);
  const legacy = legacyTaskId(resolved?.reference.id ?? ref);
  const resumable = legacy !== null && (existsSync(worktreeDir(root, legacy)) || existsSync(taskDir(root, legacy)));
  const id = resumable ? legacy : taskId(resolved && /[/#]/.test(resolved.reference.id) ? `${resolved.entry.service.id}:${resolved.reference.id}` : resolved?.reference.id ?? ref);
  const title = options.title ?? resolved?.context.title ?? ref;
  const type = options.type ?? resolved?.context.type ?? "feature";

  const pattern = config.conventions.branch ?? DEFAULT_BRANCH_PATTERN;
  const round = await nextRound(root, config, registry, out, id);
  // A task resumed keeps the branch its brief records: from round 2 it has a suffix.
  let branch = (await readBrief(root, id))?.branch ?? branchName(pattern, { type, id, slug: slugify(title) });
  if (round) {
    branch = `${branchName(pattern, { type, id, slug: slugify(title) })}-${round.number}`;
    const started = await startNextRound(root, id, { branch, reason: round.reason });
    out.info(`Round ${started.round}: ${round.reason}.${started.moved.length > 0 ? ` Moved ${started.moved.join(", ")} to tasks/${id}/history/${started.round - 1}/.` : ""}`);
  }
  const worktree = await step(out, `Creating worktrees/${id}`, () => ensureWorktree(root, id, branch, options.base ?? config.conventions.base));
  const copies = await copyLocalFiles(repo, worktree.path, config.conventions.worktreeFiles ?? []);

  const template = [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md"].find((f) => existsSync(path.join(repo, f))) ?? null;
  const notes = await writeTaskNotes(root, { id, title, branch: worktree.branch, base: worktree.base, sources: resolved?.context.files ?? [], prTemplate: template, notFetched: resolved?.context.notFetched ?? [] });

  out.info(resolved ? `${resolved.entry.service.title}: ${title}` : `Task: ${title}`);
  out.info(`Worktree: worktrees/${id} on ${worktree.branch}${worktree.existed ? ", already there and left as it was" : `, from ${worktree.base}`}`);
  for (const copy of copies) {
    if (copy.result === "copied") out.info(`Copied ${copy.file} from the clone.`);
    if (copy.result === "not ignored by git") out.warn(`Didn't copy ${copy.file}: git doesn't ignore it, so it could be committed by accident.`);
  }
  out.info(notes.length > 0 ? `Notes: wrote ${notes.join(", ")}` : `Notes: tasks/${id}/ already there and left as it was`);
  out.info(
    round
      ? `\nDone: next, run the task-changes skill for ${id} to see what reopened it, then task-plan to update the plan. Nothing was pushed.`
      : `\nDone: next, run the task-understand skill for ${id} to fill in tasks/${id}/brief.md. Nothing was pushed.`,
  );
}

/**
 * Whether starting a task begins its next round: its brief says it's finished, because its PR
 * merged or its worktree was cleaned up, or the versioning service now says its PR merged.
 * Never while the last round's worktree is there, so no unfinished work is touched.
 */
async function nextRound(root: string, config: ProjectConfig, registry: Registry, out: Output, id: string): Promise<{ number: number; reason: string } | null> {
  let brief = await readBrief(root, id);
  if (!brief) return null;
  if (!brief.finished) {
    await findTaskPr(root, config, registry, out, id).catch(() => null);
    brief = await readBrief(root, id);
    if (!brief?.finished) return null;
  }
  const record = await readRecord(root, id);
  const why = record.reopened.length > 0 ? `its ticket was reopened (${record.reopened.join(", ")})` : brief.pr ? `started again after PR #${brief.pr} merged` : "started again after it finished";
  if (existsSync(worktreeDir(root, id))) {
    throw new DevError(`${id} is finished, so starting it again starts round ${brief.round + 1}, but worktrees/${id} is still there.`, `Remove it with "dev task cleanup --remove", then run "dev task start ${id}" again.`);
  }
  return { number: brief.round + 1, reason: why };
}

export async function runTaskStatus(registry: Registry, out: Output, id: string | undefined, options: { json?: boolean } = {}): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const baseFor = basesFor(root, await workspaceBase(requireClone(root), config));

  if (id) {
    const hasWorktree = existsSync(worktreeDir(root, id));
    if (!hasWorktree && !existsSync(taskDir(root, id))) {
      throw new DevError(`There's no worktree for ${id}, and no tasks/${id}/.`, `Start it with "dev task start ${id}".`);
    }
    const state = hasWorktree ? await inspectWorktree(root, id, await baseFor(id)) : null;
    // The PR, until it's known to be merged. Best effort: status works offline.
    if ((await readBrief(root, id))?.finished === null) {
      await findTaskPr(root, config, registry, out, id).catch((error: Error) => out.warn(`Couldn't look up ${id}'s pull request: ${error.message}`));
    }
    const record = await readRecord(root, id);
    if (options.json) {
      console.log(JSON.stringify({ id, worktree: state, record }, null, 2));
      return;
    }
    if (state) {
      const base = state.base;
      out.info(`${id} on ${state.branch}`);
      out.info(`Commits not yet in ${base}: ${state.unmerged.length}${state.unmerged.map((c) => `\n  ${c}`).join("")}`);
      out.info(`Files changed: ${state.changed.length}${state.changed.map((f) => `\n  ${f}`).join("")}`);
      out.info(`Uncommitted: ${state.dirty.length}${state.dirty.map((f) => `\n  ${f}`).join("")}`);
      if (state.behind > 0) out.info(`${base} has moved on by ${state.behind} commit${state.behind === 1 ? "" : "s"} since this branch started.`);
    } else {
      out.info(`${id}: no worktree, only its record`);
    }
    out.info(`\nRecord: tasks/${id}/${record.exists ? "" : " (missing)"}`);
    if (record.exists) for (const line of describeRecord(record)) out.info(line);
    return;
  }

  const ids = await worktreeIds(root);
  if (ids.length === 0) {
    if (options.json) console.log(JSON.stringify({ tasks: [], broken: [] }, null, 2));
    else out.info('No tasks in flight. Start one with "dev task start <ref>".');
    return;
  }
  const { states, broken } = await inspectWorktrees(root, baseFor);
  const tasks = await Promise.all(states.map(async (state) => ({ id: state.id, worktree: state, record: await readRecord(root, state.id) })));
  if (options.json) {
    console.log(JSON.stringify({ tasks, broken }, null, 2));
    return;
  }
  for (const { id: each, reason } of broken) out.warn(`${each}  can't be read: ${reason}`);
  for (const { id: each, worktree: state, record } of tasks) {
    const parts = [`${state.unmerged.length} commit${state.unmerged.length === 1 ? "" : "s"}`, `${state.dirty.length} uncommitted`];
    if (state.behind > 0) parts.push(`${state.behind} behind ${state.base}`);
    const notes = recordNotes(record);
    out.info(`${each}  ${state.branch}  ${parts.join(", ")}${notes.length > 0 ? `  · ${notes.join(" · ")}` : ""}`);
  }
}

/**
 * What the task changed: the worktree against where its branch left the base, uncommitted
 * changes included, since that's what a verifier needs to see before anything is committed.
 * The base is resolved as status resolves it: the remote's copy when there is one.
 */
export async function runTaskDiff(out: Output, id: string, options: { stat?: boolean } = {}): Promise<void> {
  const root = requireWorkspaceRoot();
  const repo = requireClone(root);
  const dir = worktreeDir(root, id);
  if (!existsSync(dir)) throw new DevError(`There's no worktree for ${id}.`, `Start it with "dev task start ${id}".`);
  const base = await basesFor(root, await workspaceBase(repo, loadConfig(root)))(id);
  const ref = await baseRef(repo, base);
  const start = await gitMaybe(dir, ["merge-base", ref, "HEAD"]);
  if (!start) throw new DevError(`${id}'s branch has nothing in common with ${ref}.`, `Check the brief's base, or run "git -C worktrees/${id} log".`);
  const diff = await git(dir, ["diff", ...(options.stat ? ["--stat"] : []), start]);
  const untracked = (await git(dir, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);

  out.info(`${id}: changes since the branch left ${ref} (${start.slice(0, 7)}), committed or not.`);
  out.info(diff ? `\n${diff}` : "\nNo changes to tracked files.");
  if (untracked.length > 0) out.info(`\nNew files git doesn't track yet, so not in the diff. Read them directly:${untracked.map((f) => `\n  worktrees/${id}/${f}`).join("")}`);
}

/**
 * For worktrees git alone can't clear, the merged PR or MR the versioning service knows for
 * their branch. Best effort: without a login, the capability or a connection, only git counts.
 */
async function mergedChanges(root: string, config: ProjectConfig, registry: Registry, out: Output, states: WorktreeState[]): Promise<Map<string, ChangeRequest>> {
  const found = new Map<string, ChangeRequest>();
  const entry = config.versioning ? registry.service(config.versioning.service) : undefined;
  const find = entry?.service.versioning?.changeRequests;
  if (states.length === 0 || !config.versioning || !entry || !find) return found;
  const repository = config.versioning.repo;
  const context = workspaceServiceContext(root, entry, config, registry, out);
  const failures: string[] = [];
  try {
    const credentials = context.credentials();
    await step(out, `Asking ${entry.service.title} which branches were merged`, async (report) => {
      for (const [i, state] of states.entries()) {
        report(`${i} of ${states.length}: ${state.branch}`);
        try {
          const changes = await find(context, credentials, repository, state.branch);
          const merged = changes.find((change) => isMergedAt(change, state)) ?? changes.find((change) => change.state === "merged");
          if (merged) found.set(state.id, merged);
        } catch (error) {
          failures.push((error as Error).message);
        }
      }
    });
  } catch (error) {
    failures.push((error as Error).message);
  }
  if (failures.length > 0) out.warn(`Couldn't ask ${entry.service.title} which branches were merged (${failures[0]}), so squash-merged branches may be kept.`);
  return found;
}

export async function runTaskCleanup(registry: Registry, out: Output, options: { remove?: boolean }): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const repo = requireClone(root);
  const fallback = await workspaceBase(repo, config);
  const remote = await step(out, "Fetching from the repository's remote", () => fetchRemote(repo));
  const fetched = remote === "fetched";
  if (remote === "unreachable") out.warn("Couldn't reach the repository's remote, so only worktrees whose commits are all in the base count as safe.");
  const { states, broken } = await inspectWorktrees(root, basesFor(root, fallback));
  // Only ask the service about clean worktrees git can't already clear, and never a detached one.
  const unclear = states.filter((s) => s.dirty.length === 0 && s.branch !== "HEAD" && !isSafeToRemove(s, { trustUpstream: fetched }));
  const merged = await mergedChanges(root, config, registry, out, unclear);
  const safeOptions = (s: WorktreeState) => ({ trustUpstream: fetched, merged: merged.get(s.id) });
  const safe = states.filter((s) => isSafeToRemove(s, safeOptions(s)));
  const kept = states.filter((s) => !isSafeToRemove(s, safeOptions(s)));
  for (const { id, reason } of broken) out.warn(`Keep ${id}: git can't read it (${reason}).`);

  if (states.length === 0 && broken.length === 0) {
    out.info("No worktrees.");
    return;
  }
  for (const state of kept) {
    const change = merged.get(state.id);
    const reasons = [
      state.unmerged.length > 0 ? `${state.unmerged.length} commit(s) not in ${state.base}${!fetched && state.unpushed?.length === 0 ? " (pushed, but the remote couldn't be checked)" : ""}` : "",
      change && !isMergedAt(change, state) ? `${change.url} merged an earlier commit` : "",
      state.dirty.length > 0 ? `${state.dirty.length} uncommitted change(s)` : "",
    ].filter(Boolean);
    out.info(`Keep ${state.id}: ${reasons.join(", ")}.`);
  }
  if (safe.length === 0) {
    out.info("Nothing is safe to remove.");
    return;
  }
  const label = (s: WorktreeState) => {
    const change = merged.get(s.id);
    return change && isMergedAt(change, s) && s.unmerged.length > 0 ? `${s.id} (merged by ${change.url})` : s.id;
  };
  if (!options.remove) {
    out.info(`Safe to remove, nothing would be lost: ${safe.map(label).join(", ")}.\nRun "dev task cleanup --remove" to remove them. Their notes in tasks/ stay.`);
    return;
  }
  for (const state of safe) {
    try {
      const note = await removeWorktree(root, state, { fetched, merged: merged.get(state.id) });
      // The task is finished: its watch window starts when its PR merged, or today if that isn't known.
      const change = merged.get(state.id);
      if (change?.state === "merged") await setBriefFields(root, state.id, { pr: change.number, finished: change.mergedAt?.slice(0, 10) ?? today() });
      else if ((await readBrief(root, state.id))?.finished === null) await setBriefFields(root, state.id, { finished: today() });
      out.info(`Removed worktrees/${state.id}. Its notes in tasks/${state.id}/ stay.`);
      if (note) out.warn(`  ${note}`);
    } catch (error) {
      process.exitCode = 1;
      out.warn(`Kept ${state.id}: ${(error as Error).message}`);
    }
  }
}

export interface ListOptions {
  mine?: boolean;
  all?: boolean;
  refresh?: boolean;
  json?: boolean;
}

/**
 * The tasks from every task source, from the files the last sync wrote. By default: open
 * tasks in scope, and open ones assigned to you even if they were fetched as context.
 */
export async function runTaskList(registry: Registry, out: Output, options: ListOptions): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const sources = enabledServices(config, registry).filter((entry) => entry.service.tasks);
  if (sources.length === 0) {
    out.info('No enabled service holds tasks. Add one, like "dev add jira".');
    return;
  }

  if (options.refresh) {
    const { syncServices } = await import("./sync.ts");
    const refreshOut: Output = options.json ? { info: (s) => console.error(s), warn: (s) => console.error(s), progress: (s) => console.error(s) } : out;
    if (!await withRefresh(root, "dev task list --refresh", () => syncServices(root, config, registry, refreshOut, sources))) process.exitCode = 1;
  }

  const groups: Array<{ title: string; tasks: TaskItem[]; asOf: string | null }> = [];
  for (const entry of sources) {
    const all = await entry.service.tasks!.list(workspaceServiceContext(root, entry, config, registry, out));
    const tasks = all
      .filter((task) => options.all || !task.done)
      .filter((task) => (options.mine ? task.mine : options.all || task.inScope || task.mine))
      .sort((a, b) => Number(b.mine) - Number(a.mine) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.id.localeCompare(b.id, undefined, { numeric: true }));
    let asOf: string | null = null;
    try { asOf = JSON.parse((await import("node:fs")).readFileSync(path.join(root, ".dev/state/sync-times", `${entry.service.id}.json`), "utf8")).completed; } catch {}
    asOf ??= all.map((task) => task.synced ?? "").sort().at(-1) || null;
    groups.push({ title: entry.service.title, tasks, asOf });
  }

  if (options.json) {
    console.log(JSON.stringify(groups.map((g) => ({ service: g.title, asOf: g.asOf, tasks: g.tasks })), null, 2));
    return;
  }

  const today = new Date().toLocaleDateString("en-CA");
  for (const group of groups) {
    const when = group.asOf ? new Date(group.asOf).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never synced";
    out.info(`${group.title}, as of ${when}: ${group.tasks.length} task${group.tasks.length === 1 ? "" : "s"}`);
    for (const task of group.tasks) {
      const notes = [
        ...(task.due ? [`due ${task.due}${task.due < today && !task.done ? ", overdue" : task.due === today ? ", today" : ""}`] : []),
        ...(task.mine ? ["mine"] : []),
        ...(task.via !== "scope" ? [task.via] : []),
      ];
      out.info(`  ${task.id}  [${task.status}]  ${task.title}${notes.length > 0 ? `  · ${notes.join(" · ")}` : ""}  (${task.file})`);
    }
  }
  if (!options.refresh) out.info('From the last sync. Add --refresh to sync first.');
}
