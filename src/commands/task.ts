import { existsSync } from "node:fs";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import type { Output, Reference, ServiceEntry, TaskContext } from "../plugins/types.ts";
import { workspaceServiceContext } from "../core/context.ts";
import { DevError } from "../core/output.ts";
import { loadConfig, type ProjectConfig } from "../core/project-config.ts";
import { enabledServices } from "../core/scaffold.ts";
import { taskDir, taskId, writeTaskNotes } from "../core/tasks.ts";
import {
  branchName,
  copyLocalFiles,
  DEFAULT_BRANCH_PATTERN,
  defaultBranch,
  ensureWorktree,
  inspectWorktree,
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
  for (const entry of enabledServices(config, registry)) {
    const links = entry.service.links;
    const reference = links?.find(ref).find((r) => r.id === ref || r.url === ref);
    if (!links || !reference) continue;

    const context = workspaceServiceContext(root, entry, config, registry, out);
    const file = await links.fetch(context, reference);
    const task = entry.service.contribute?.taskStart
      ? await entry.service.contribute.taskStart(context, reference)
      : { title: reference.id, files: [path.relative(root, file)], references: [] };

    // One step further: what the item links to, like a parent's spec.
    for (const next of task.references) {
      const owner = enabledServices(config, registry).find((e) => e.key === next.service);
      if (!owner?.service.links) continue;
      try {
        task.files.push(path.relative(root, await owner.service.links.fetch(workspaceServiceContext(root, owner, config, registry, out), next)));
      } catch (error) {
        out.warn(`Couldn't fetch ${next.id} from ${owner.service.title}: ${(error as Error).message}`);
      }
    }
    return { entry, reference, context: task };
  }
  return null;
}

export async function runTaskStart(registry: Registry, out: Output, ref: string, options: StartOptions): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const repo = requireClone(root);

  const resolved = await resolve(root, config, registry, ref, out);
  const id = taskId(resolved?.reference.id ?? ref);
  const title = options.title ?? resolved?.context.title ?? ref;
  const type = options.type ?? resolved?.context.type ?? "feature";

  const pattern = config.conventions.branch ?? DEFAULT_BRANCH_PATTERN;
  const worktree = await ensureWorktree(root, id, branchName(pattern, { type, id, slug: slugify(title) }), options.base);
  const copies = await copyLocalFiles(repo, worktree.path, config.conventions.worktreeFiles ?? []);

  const template = [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md"].find((f) => existsSync(path.join(repo, f))) ?? null;
  const notes = await writeTaskNotes(root, { id, title, branch: worktree.branch, sources: resolved?.context.files ?? [], prTemplate: template });

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
  for (const each of ids) {
    const state = await inspectWorktree(root, each, base);
    const parts = [`${state.unmerged.length} commit${state.unmerged.length === 1 ? "" : "s"}`, `${state.dirty.length} uncommitted`];
    if (state.behind > 0) parts.push(`${state.behind} behind ${base}`);
    out.info(`${each}  ${state.branch}  ${parts.join(", ")}`);
  }
}

export async function runTaskCleanup(out: Output, options: { remove?: boolean }): Promise<void> {
  const root = requireWorkspaceRoot();
  const base = await defaultBranch(requireClone(root));
  const states = await Promise.all((await worktreeIds(root)).map((id) => inspectWorktree(root, id, base)));
  const safe = states.filter(isSafeToRemove);
  const kept = states.filter((s) => !isSafeToRemove(s));

  if (states.length === 0) {
    out.info("No worktrees.");
    return;
  }
  for (const state of kept) {
    const reasons = [state.unmerged.length > 0 ? `${state.unmerged.length} commit(s) not in ${base}` : "", state.dirty.length > 0 ? `${state.dirty.length} uncommitted change(s)` : ""].filter(Boolean);
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
    await removeWorktree(root, state);
    out.info(`Removed worktrees/${state.id}. Its notes in tasks/${state.id}/ stay.`);
  }
}
