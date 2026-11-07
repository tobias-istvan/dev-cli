import { constants, existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, gitMaybe } from "./git.ts";
import { DevError } from "./output.ts";

/**
 * Worktrees: one checkout per task under worktrees/<id>, cut from the clone in
 * repository/. Keyed by task id alone, so "is this task in flight?" is one folder check.
 */

export const DEFAULT_BRANCH_PATTERN = "{type}/{id}-{slug}";

export function repositoryDir(root: string): string {
  return path.join(root, "repository");
}

export function worktreeDir(root: string, id: string): string {
  return path.join(root, "worktrees", id);
}

export function requireClone(root: string): string {
  const repo = repositoryDir(root);
  if (!existsSync(path.join(repo, ".git"))) {
    throw new DevError("There's no code clone in repository/.", 'Run "dev init" to clone it.');
  }
  return repo;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 8)
      .join("-") || "work"
  );
}

export function branchName(pattern: string, values: { type: string; id: string; slug: string }): string {
  return pattern
    .replace(/\{type\}/g, values.type)
    .replace(/\{id\}/g, values.id)
    .replace(/\{slug\}/g, values.slug)
    .replace(/\/{2,}/g, "/")
    .replace(/^[/-]+|[/-]+$/g, "");
}

/** The default branch, from origin/HEAD rather than assumed. */
export async function defaultBranch(repo: string): Promise<string> {
  const ref = await gitMaybe(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  return ref ? ref.replace("refs/remotes/origin/", "") : "main";
}

/**
 * A worktree is its own git root, and some tools stop looking for instructions there.
 * This file points them back at the workspace. Git ignores it through the clone's own
 * exclude file, so it can't end up in a commit.
 */
const INSTRUCTIONS = `---
applyTo: "**"
---

# This is a task worktree inside a dev workspace

The workspace root is two folders up. Read \`../../AGENTS.md\` before working here, and
the task's notes in \`../../tasks/<this folder's name>/\`.

Never push and never open a pull request from here unless the person asks you to.
`;

const INSTRUCTIONS_FILE = ".github/instructions/dev-workspace.instructions.md";
const COPIED = [".github/hooks/dev.json", ".claude/settings.json", ".mcp.json", ".vscode/mcp.json"];

async function isTracked(worktree: string, file: string): Promise<boolean> {
  return (await gitMaybe(worktree, ["ls-files", "--error-unmatch", file])) !== null;
}

async function exclude(worktree: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const relative = await git(worktree, ["rev-parse", "--git-path", "info/exclude"]);
  const file = path.resolve(worktree, relative);
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  const missing = files.filter((f) => !current.split("\n").includes(`/${f}`));
  if (missing.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${missing.map((f) => `/${f}`).join("\n")}\n`);
}

/** Never replaces a file that's there, and never touches one the code repository tracks. */
export async function addAgentFiles(root: string, worktree: string): Promise<void> {
  const written: string[] = [];
  const add = async (file: string, write: (target: string) => Promise<void>): Promise<void> => {
    const target = path.join(worktree, file);
    if (existsSync(target) || (await isTracked(worktree, file))) return;
    await mkdir(path.dirname(target), { recursive: true });
    await write(target);
    written.push(file);
  };

  await add(INSTRUCTIONS_FILE, (target) => writeFile(target, INSTRUCTIONS));
  for (const file of COPIED) {
    const source = path.join(root, file);
    if (existsSync(source)) await add(file, (target) => copyFile(source, target));
  }
  await exclude(worktree, written);
}

export type CopyResult = "copied" | "already there" | "not in the clone" | "not ignored by git";

/**
 * Copies local-only files, like an app's .env.local, from the clone into a worktree, so
 * the app runs there straight away. Only files git ignores: otherwise a routine git add
 * could commit secrets. Contents are never read or printed.
 */
export async function copyLocalFiles(repo: string, worktree: string, files: string[]): Promise<Array<{ file: string; result: CopyResult }>> {
  const results: Array<{ file: string; result: CopyResult }> = [];
  for (const file of files) {
    const source = path.join(repo, file);
    const target = path.join(worktree, file);
    let result: CopyResult;
    if (existsSync(target)) result = "already there";
    else if (!existsSync(source)) result = "not in the clone";
    else if ((await gitMaybe(worktree, ["check-ignore", "--quiet", "--no-index", file])) === null) result = "not ignored by git";
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target, constants.COPYFILE_EXCL);
      result = "copied";
    }
    results.push({ file, result });
  }
  return results;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  existed: boolean;
  base: string;
}

/** Creates a task's worktree, or reports the existing one without touching its work. */
export async function ensureWorktree(root: string, id: string, branch: string, base?: string): Promise<WorktreeInfo> {
  const repo = requireClone(root);
  const dir = worktreeDir(root, id);
  const baseBranch = base ?? (await defaultBranch(repo));

  if (existsSync(dir)) {
    await addAgentFiles(root, dir);
    return { path: dir, branch: await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), existed: true, base: baseBranch };
  }

  // Start from what's on origin, not from a clone that may be days old.
  await gitMaybe(repo, ["fetch", "origin", "--prune"]);
  const start = (await gitMaybe(repo, ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`])) ? `origin/${baseBranch}` : baseBranch;

  // --no-track: otherwise the branch tracks the base, and git status and git pull
  // compare against it. It gets its real upstream when it's first pushed.
  await git(repo, ["worktree", "add", dir, "-b", branch, start, "--no-track"]);
  await addAgentFiles(root, dir);
  return { path: dir, branch, existed: false, base: baseBranch };
}

export interface WorktreeState {
  id: string;
  dir: string;
  branch: string;
  /** Commits on the branch not yet in the base. */
  unmerged: string[];
  /** Files changed on the branch compared with the base. */
  changed: string[];
  /** Uncommitted changes. */
  dirty: string[];
  /** Commits the base has moved on since the branch started. */
  behind: number;
}

export async function worktreeIds(root: string): Promise<string[]> {
  try {
    return (await readdir(path.join(root, "worktrees"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function inspectWorktree(root: string, id: string, base: string): Promise<WorktreeState> {
  const dir = worktreeDir(root, id);
  const ref = (await gitMaybe(dir, ["rev-parse", "--verify", "--quiet", `origin/${base}`])) ? `origin/${base}` : base;
  const lines = (value: string | null) => (value ?? "").split("\n").filter(Boolean);
  const [branch, unmerged, changed, dirty, behind] = await Promise.all([
    gitMaybe(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitMaybe(dir, ["log", "--oneline", `${ref}..HEAD`]),
    gitMaybe(dir, ["diff", "--name-only", `${ref}...HEAD`]),
    gitMaybe(dir, ["status", "--short"]),
    gitMaybe(dir, ["rev-list", "--count", `HEAD..${ref}`]),
  ]);
  return { id, dir, branch: branch ?? "?", unmerged: lines(unmerged), changed: lines(changed), dirty: lines(dirty), behind: Number(behind) || 0 };
}

/** Safe means nothing is lost: no uncommitted changes, and every commit already in the base. */
export function isSafeToRemove(state: WorktreeState): boolean {
  return state.unmerged.length === 0 && state.dirty.length === 0;
}

export async function removeWorktree(root: string, state: WorktreeState): Promise<void> {
  const repo = requireClone(root);
  await git(repo, ["worktree", "remove", state.dir]);
  // The branch holds nothing the base doesn't, so deleting it loses nothing.
  if (state.branch && state.branch !== "HEAD") await gitMaybe(repo, ["branch", "-D", state.branch]);
}
