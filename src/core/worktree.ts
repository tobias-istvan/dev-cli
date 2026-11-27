import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { safePath } from "./files.ts";
import path from "node:path";
import { git, gitMaybe } from "./git.ts";
import { DevError } from "./output.ts";
import type { ChangeRequest } from "../plugins/types.ts";

/**
 * Worktrees: one checkout per task under worktrees/<id>, cut from the clone in
 * repository/. Keyed by task id alone, so "is this task in flight?" is one folder check.
 */

export const DEFAULT_BRANCH_PATTERN = "{type}/{id}-{slug}";

export function repositoryDir(root: string): string {
  return path.join(root, "repository");
}

export function worktreeDir(root: string, id: string): string {
  return safePath(root, `worktrees/${id}`);
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

/**
 * The clone's remote: the one its checked-out branch tracks, else origin, else the first.
 * Null for a clone that only lives here, which works too, with nothing to fetch.
 */
export async function remoteName(repo: string): Promise<string | null> {
  const remotes = ((await gitMaybe(repo, ["remote"])) ?? "").split("\n").filter(Boolean);
  if (remotes.length === 0) return null;
  const branch = await gitMaybe(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const tracked = branch ? await gitMaybe(repo, ["config", "--get", `branch.${branch}.remote`]) : null;
  if (tracked && remotes.includes(tracked)) return tracked;
  return remotes.includes("origin") ? "origin" : remotes[0]!;
}

/** The default branch: the remote's, else main or master, else whatever the clone has checked out. */
export async function defaultBranch(repo: string): Promise<string> {
  const remote = await remoteName(repo);
  const ref = remote ? await gitMaybe(repo, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]) : null;
  if (ref) return ref.replace(`refs/remotes/${remote}/`, "");
  for (const name of ["main", "master"]) {
    if (await gitMaybe(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  return (await gitMaybe(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])) ?? "main";
}

/** What to compare with or start from: the remote's copy of the base when there is one, else the local base. */
export async function baseRef(repo: string, base: string): Promise<string> {
  const remote = await remoteName(repo);
  return remote && (await gitMaybe(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${base}`])) ? `${remote}/${base}` : base;
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

The workspace root is two folders up. Read \`../../AGENTS.md\` before working here, then
\`../../INSTRUCTIONS.md\` if it exists: the workspace's own instructions. Read the task's
notes in \`../../tasks/<this folder's name>/\`.
For pr-N or mr-N reviews, use ../../pull-requests/N/ or ../../merge-requests/N/ instead.

Never push and never open a pull request from here unless the person asks you to.
`;

const INSTRUCTIONS_FILE = ".github/instructions/dev-workspace.instructions.md";
const COPIED = [".github/hooks/dev.json", ".claude/settings.json", ".mcp.json", ".vscode/mcp.json"];
const SKILL_FOLDERS = [".github/skills", ".claude/skills", ".agents/skills"];

/** The workspace's skills, so an agent opened in a worktree finds them too. */
async function skillFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const folder of SKILL_FOLDERS) {
    try {
      for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(path.join(root, folder, entry.name, "SKILL.md"))) files.push(`${folder}/${entry.name}/SKILL.md`);
      }
    } catch {
      // No skills for this tool.
    }
  }
  return files.sort();
}

async function isTracked(worktree: string, file: string): Promise<boolean> {
  return (await gitMaybe(worktree, ["ls-files", "--error-unmatch", file])) !== null;
}

async function excludeFile(worktree: string): Promise<string> {
  return path.resolve(worktree, await git(worktree, ["rev-parse", "--git-path", "info/exclude"]));
}

async function exclude(worktree: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const file = await excludeFile(worktree);
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  const missing = files.filter((f) => !current.split("\n").includes(`/${f}`));
  if (missing.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${missing.map((f) => `/${f}`).join("\n")}\n`);
}

const hash = (content: string): string => createHash("sha256").update(content).digest("hex");

/**
 * What dev wrote into this worktree, each file with its content's hash. Kept in the
 * worktree's own git folder: info/exclude is shared by every worktree of the clone, so
 * it can't say which worktree's files are dev's.
 */
async function manifestFile(worktree: string): Promise<string | null> {
  const dir = await gitMaybe(worktree, ["rev-parse", "--git-dir"]);
  return dir ? path.join(path.resolve(worktree, dir), "dev-agent-files.json") : null;
}

async function readManifest(file: string | null): Promise<Record<string, string>> {
  if (!file) return {};
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Never touches a file the code repository tracks, or one that isn't dev's: a file is dev's
 * while it's in this worktree's manifest and still as dev wrote it. With refresh, dev's
 * copies are brought up to date with the workspace's, and the ones whose source is gone are
 * removed: they're mirrors, edited at the workspace root. Returns the files changed.
 */
export async function addAgentFiles(root: string, worktree: string, options: { refresh?: boolean } = {}): Promise<string[]> {
  const sources: Array<[string, string]> = [[INSTRUCTIONS_FILE, INSTRUCTIONS]];
  for (const file of [...COPIED, ...(await skillFiles(root))]) {
    const source = safePath(root, file);
    if (existsSync(source)) sources.push([file, await readFile(source, "utf8")]);
  }
  const targets = new Map(sources.map(([file]) => [file, safePath(worktree, file)]));
  const manifest = await manifestFile(worktree);
  const recorded = await readManifest(manifest);
  const next: Record<string, string> = {};
  const isOurs = async (file: string, target: string): Promise<boolean> =>
    recorded[file] !== undefined && !(await isTracked(worktree, file)) && hash(await readFile(target, "utf8")) === recorded[file];

  const written: string[] = [];
  for (const [file, content] of sources) {
    const target = targets.get(file)!;
    if (existsSync(target)) {
      if (!(await isOurs(file, target))) continue;
      next[file] = recorded[file]!;
      if (!options.refresh || (await readFile(target, "utf8")) === content) continue;
    } else if (await isTracked(worktree, file)) {
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    next[file] = hash(content);
    written.push(file);
  }

  // Copies whose source is gone from the workspace, like a disconnected service's skill.
  const removed: string[] = [];
  for (const file of Object.keys(recorded)) {
    if (targets.has(file)) continue;
    const target = safePath(worktree, file);
    if (!existsSync(target)) continue;
    if (!options.refresh || !(await isOurs(file, target))) {
      if (!options.refresh) next[file] = recorded[file]!;
      continue;
    }
    await rm(target);
    removed.push(file);
    // A skill's folder goes with its last file.
    await rmdir(path.dirname(target)).catch(() => undefined);
  }

  await exclude(worktree, written);
  if (manifest && JSON.stringify(next) !== JSON.stringify(recorded)) await writeFile(manifest, `${JSON.stringify(next, null, 2)}\n`);
  return [...written, ...removed];
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
    const source = safePath(repo, file);
    const target = safePath(worktree, file);
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

  // Start from what's on the remote, not from a clone that may be days old. Offline, the last
  // fetch will do: nothing is lost by starting from an older base. Without a remote, the local base.
  await fetchRemote(repo);
  const start = await baseRef(repo, baseBranch);

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
  /** The commit checked out. */
  head: string;
  /** The branch it's compared with. */
  base: string;
  /** Commits on the branch not yet in the base. */
  unmerged: string[];
  /** Files changed on the branch compared with the base. */
  changed: string[];
  /** Uncommitted changes. */
  dirty: string[];
  /** Commits the base has moved on since the branch started. */
  behind: number;
  /** Commits not on the branch's upstream, or null when it has none. */
  unpushed: string[] | null;
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
  const ref = await baseRef(existsSync(path.join(repositoryDir(root), ".git")) ? repositoryDir(root) : dir, base);
  const lines = (value: string | null) => (value ?? "").split("\n").filter(Boolean);
  const [branch, head, unmerged, changed, dirty, behind, unpushed] = await Promise.all([
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(dir, ["rev-parse", "HEAD"]),
    git(dir, ["log", "--oneline", `${ref}..HEAD`]),
    git(dir, ["diff", "--name-only", `${ref}...HEAD`]),
    git(dir, ["status", "--short"]),
    git(dir, ["rev-list", "--count", `HEAD..${ref}`]),
    remoteUnpushed(dir),
  ]);
  return { id, dir, branch: branch ?? "?", head, base, unmerged: lines(unmerged), changed: lines(changed), dirty: lines(dirty), behind: Number(behind) || 0, unpushed: unpushed === null ? null : lines(unpushed) };
}

/** Every worktree's state, each against its own base. One that git can't read is listed as broken, never taken as safe to remove. */
export async function inspectWorktrees(root: string, baseFor: (id: string) => Promise<string>): Promise<{ states: WorktreeState[]; broken: Array<{ id: string; reason: string }> }> {
  const ids = await worktreeIds(root);
  const results = await Promise.allSettled(ids.map(async (id) => inspectWorktree(root, id, await baseFor(id))));
  const states: WorktreeState[] = [];
  const broken: Array<{ id: string; reason: string }> = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") states.push(result.value);
    else broken.push({ id: ids[i]!, reason: (result.reason as Error).message });
  });
  return { states, broken };
}

/** Fetches the clone's remote so the base and upstreams are current. */
export async function fetchRemote(repo: string): Promise<"fetched" | "unreachable" | "none"> {
  const remote = await remoteName(repo);
  if (!remote) return "none";
  return (await gitMaybe(repo, ["fetch", remote, "--prune"])) !== null ? "fetched" : "unreachable";
}

/**
 * Safe means nothing is lost: no uncommitted changes, and every commit already in the base,
 * or on the branch's own upstream, as with a PR checked out for review. Without a fresh fetch
 * the upstream can't be trusted (it may have been deleted on origin), so only the base counts.
 *
 * A PR or MR merged at exactly this commit counts too, wherever it merged: a squash or rebase
 * merge never puts the branch's own commits in the base, and the host usually deletes the
 * branch.
 */
export function isSafeToRemove(state: WorktreeState, options: { trustUpstream?: boolean; merged?: ChangeRequest | null } = {}): boolean {
  if (state.dirty.length > 0) return false;
  if (options.merged && isMergedAt(options.merged, state)) return true;
  return state.unmerged.length === 0 || (options.trustUpstream !== false && state.unpushed !== null && state.unpushed.length === 0);
}

/** Whether a PR or MR merged this worktree's branch as it is now. */
export function isMergedAt(change: ChangeRequest, state: WorktreeState): boolean {
  return change.state === "merged" && change.headSha === state.head;
}

/** Removes a worktree and its branch, after checking again that nothing would be lost. Returns a note when the branch is kept. */
export async function removeWorktree(root: string, state: WorktreeState, options: { fetched: boolean; merged?: ChangeRequest | null }): Promise<string | null> {
  const repo = requireClone(root);
  const fresh = await inspectWorktree(root, state.id, state.base);
  if (!isSafeToRemove(fresh, { trustUpstream: options.fetched, merged: options.merged }) || fresh.branch !== state.branch) throw new DevError("Worktree changed or is no longer safe to remove.");
  await git(repo, ["worktree", "remove", state.dir]);
  if (!state.branch || state.branch === "HEAD") return null;
  // The check above already proved every commit is in the base, on the upstream or merged by a PR. git branch -d
  // would compare with whatever the clone has checked out instead, and refuse merged branches.
  try {
    await git(repo, ["branch", "-D", state.branch]);
    return null;
  } catch (error) {
    return `Kept branch ${state.branch}: ${(error as Error).message}`;
  }
}

/**
 * A worktree for reviewing a PR or MR, on its own branch, so changes can be committed and
 * pushed back, never a detached commit. A branch from the same repository is tracked from
 * origin; one from a fork comes from the host's special ref (like pull/12/head) into a local
 * branch named after the review.
 */
export async function reviewWorktree(
  root: string,
  id: string,
  head: { branch: string } | { forkRef: string },
): Promise<{ path: string; branch: string; existed: boolean }> {
  const repo = requireClone(root);
  const origin = await remoteName(repo);
  if (!origin) throw new DevError("Reviewing a pull request needs the repository's remote, and the clone in repository/ has none.", "Add it with: git -C repository remote add origin <url>");
  const dir = worktreeDir(root, id);
  const branch = "branch" in head ? head.branch : id;
  const remote = "branch" in head ? `refs/remotes/${origin}/${branch}` : `refs/remotes/dev-reviews/${id}`;
  const source = "branch" in head ? `refs/heads/${branch}` : head.forkRef;
  await git(repo, ["fetch", origin, `+${source}:${remote}`]);
  const existed = existsSync(dir);
  if (!existed) {
    const local = await gitMaybe(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    if (local) await git(repo, ["worktree", "add", dir, branch]);
    else await git(repo, ["worktree", "add", "--no-track", "-b", branch, dir, remote]);
    if ("branch" in head) await git(dir, ["branch", "--set-upstream-to", `${origin}/${branch}`]);
  }
  const current = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== branch) throw new DevError(`Review worktree has unexpected branch ${current}.`);
  const localSha = await git(dir, ["rev-parse", "HEAD"]);
  const remoteSha = await git(repo, ["rev-parse", remote]);
  if (localSha !== remoteSha) {
    if (await git(dir, ["status", "--porcelain"])) throw new DevError("Review worktree is stale and has local changes. Commit or preserve them before updating.");
    await git(dir, ["merge", "--ff-only", remote]);
    if (await git(dir, ["rev-parse", "HEAD"]) !== remoteSha) throw new DevError("Review branch contains additional local commits; review the divergence before proceeding.");
  }
  await addAgentFiles(root, dir);
  return { path: dir, branch, existed };
}
async function remoteUnpushed(dir: string): Promise<string | null> {
  const ref = await gitMaybe(dir, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  return ref?.startsWith("refs/remotes/") ? git(dir, ["log", "--oneline", `${ref}..HEAD`]) : null;
}
