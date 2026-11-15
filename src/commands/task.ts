import { withRefresh } from "../core/refresh.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import type { Output, Reference, ServiceEntry, TaskContext, TaskItem } from "../plugins/types.ts";
import { workspaceServiceContext } from "../core/context.ts";
import { DevError } from "../core/output.ts";
import { count, step } from "../core/progress.ts";
import { loadConfig, type ProjectConfig } from "../core/project-config.ts";
import { enabledServices } from "../core/scaffold.ts";
import { legacyTaskId, taskDir, taskId, writeTaskNotes } from "../core/tasks.ts";
import {
  branchName,
  copyLocalFiles,
  DEFAULT_BRANCH_PATTERN,
  defaultBranch,
  ensureWorktree,
  fetchRemote,
  inspectWorktree,
  inspectWorktrees,
  isSafeToRemove,
  removeWorktree,
  requireClone,
  slugify,
  worktreeDir,
  worktreeIds,
} from "../core/worktree.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";

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
  const worktree = await step(out, `Creating worktrees/${id}`, () => ensureWorktree(root, id, branchName(pattern, { type, id, slug: slugify(title) }), options.base));
  const copies = await copyLocalFiles(repo, worktree.path, config.conventions.worktreeFiles ?? []);

  const template = [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md"].find((f) => existsSync(path.join(repo, f))) ?? null;
  const notes = await writeTaskNotes(root, { id, title, branch: worktree.branch, sources: resolved?.context.files ?? [], prTemplate: template, notFetched: resolved?.context.notFetched ?? [] });

  out.info(resolved ? `${resolved.entry.service.title}: ${title}` : `Task: ${title}`);
  out.info(`Worktree: worktrees/${id} on ${worktree.branch}${worktree.existed ? ", already there and left as it was" : `, from ${worktree.base}`}`);
  for (const copy of copies) {
    if (copy.result === "copied") out.info(`Copied ${copy.file} from the clone.`);
    if (copy.result === "not ignored by git") out.warn(`Didn't copy ${copy.file}: git doesn't ignore it, so it could be committed by accident.`);
  }
  out.info(notes.length > 0 ? `Notes: wrote ${notes.join(", ")}` : `Notes: tasks/${id}/ already there and left as it was`);
  out.info(`\nDone: next, fill in tasks/${id}/brief.md and work in worktrees/${id}. Nothing was pushed.`);
}

export async function runTaskStatus(out: Output, id?: string): Promise<void> {
  const root = requireWorkspaceRoot();
  const base = await defaultBranch(requireClone(root));

  if (id) {
    if (!existsSync(worktreeDir(root, id))) {
      throw new DevError(`There's no worktree for ${id}.`, `Start it with "dev task start ${id}".`);
    }
    const state = await inspectWorktree(root, id, base);
    out.info(`${id} on ${state.branch}`);
    out.info(`Commits not yet in ${base}: ${state.unmerged.length}${state.unmerged.map((c) => `\n  ${c}`).join("")}`);
    out.info(`Files changed: ${state.changed.length}${state.changed.map((f) => `\n  ${f}`).join("")}`);
    out.info(`Uncommitted: ${state.dirty.length}${state.dirty.map((f) => `\n  ${f}`).join("")}`);
    if (state.behind > 0) out.info(`${base} has moved on by ${state.behind} commit${state.behind === 1 ? "" : "s"} since this branch started.`);
    out.info(`Notes: tasks/${id}/${existsSync(taskDir(root, id)) ? "" : " (missing)"}`);
    return;
  }

  const ids = await worktreeIds(root);
  if (ids.length === 0) {
    out.info('No tasks in flight. Start one with "dev task start <ref>".');
    return;
  }
  const { states, broken } = await inspectWorktrees(root, base);
  for (const { id: each, reason } of broken) out.warn(`${each}  can't be read: ${reason}`);
  for (const state of states) {
    const each = state.id;
    const parts = [`${state.unmerged.length} commit${state.unmerged.length === 1 ? "" : "s"}`, `${state.dirty.length} uncommitted`];
    if (state.behind > 0) parts.push(`${state.behind} behind ${base}`);
    out.info(`${each}  ${state.branch}  ${parts.join(", ")}`);
  }
}

export async function runTaskCleanup(out: Output, options: { remove?: boolean }): Promise<void> {
  const root = requireWorkspaceRoot();
  const base = await defaultBranch(requireClone(root));
  const remote = await step(out, "Fetching from the repository's remote", () => fetchRemote(requireClone(root)));
  const fetched = remote === "fetched";
  if (remote === "unreachable") out.warn("Couldn't reach the repository's remote, so only worktrees whose commits are all in the base count as safe.");
  const { states, broken } = await inspectWorktrees(root, base);
  const safe = states.filter((s) => isSafeToRemove(s, { trustUpstream: fetched }));
  const kept = states.filter((s) => !isSafeToRemove(s, { trustUpstream: fetched }));
  for (const { id, reason } of broken) out.warn(`Keep ${id}: git can't read it (${reason}).`);

  if (states.length === 0 && broken.length === 0) {
    out.info("No worktrees.");
    return;
  }
  for (const state of kept) {
    const reasons = [state.unmerged.length > 0 ? `${state.unmerged.length} commit(s) not in ${base}${!fetched && state.unpushed?.length === 0 ? " (pushed, but the remote couldn't be checked)" : ""}` : "", state.dirty.length > 0 ? `${state.dirty.length} uncommitted change(s)` : ""].filter(Boolean);
    out.info(`Keep ${state.id}: ${reasons.join(", ")}.`);
  }
  if (safe.length === 0) {
    out.info("Nothing is safe to remove.");
    return;
  }
  if (!options.remove) {
    out.info(`Safe to remove, nothing would be lost: ${safe.map((s) => s.id).join(", ")}.\nRun "dev task cleanup --remove" to remove them. Their notes in tasks/ stay.`);
    return;
  }
  for (const state of safe) {
    try {
      const note = await removeWorktree(root, state, { fetched });
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
