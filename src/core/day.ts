import { atomicWrite } from "./files.ts";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Output } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { workspaceServiceContext } from "./context.ts";
import { git, gitMaybe } from "./git.ts";
import type { ProjectConfig } from "./project-config.ts";
import { enabledServices } from "./scaffold.ts";
import { baseRef, defaultBranch, inspectWorktrees, remoteName, isSafeToRemove, repositoryDir, worktreeDir, worktreeIds } from "./worktree.ts";

/**
 * The day: snapshot.md says what to work on, and work-sessions/<date>/summary.md records
 * what happened. The summary's facts are rebuilt every run; the sections people and agents
 * write are kept, and the next day's snapshot carries their Next steps over.
 */

export const WRITTEN_SECTIONS = ["What happened", "Decisions", "Next steps", "Blocked"] as const;

const PLACEHOLDERS: Record<(typeof WRITTEN_SECTIONS)[number], string> = {
  "What happened": "_A few lines on what got done, in plain words._",
  Decisions: "_Choices made today, and why, so nobody has to rediscover them._",
  "Next steps": "_The very next things to do. The next session starts from here._",
  Blocked: "_Anything waiting on someone else, or open questions._",
};

export function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

export function dayDir(root: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Date must be a valid YYYY-MM-DD calendar date.");
  return path.join(root, "work-sessions", date);
}

export function readSection(document: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return document.match(new RegExp(`(?:^|\\n)## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1]?.trim() ?? "";
}

export function isPlaceholder(section: string): boolean {
  return !section || section.startsWith("_");
}

/** Summaries newest first, by their folder's date. */
export async function summaries(root: string): Promise<Array<{ date: string; file: string }>> {
  try {
    return (await readdir(path.join(root, "work-sessions")))
      .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
      .sort()
      .reverse()
      .map((date) => ({ date, file: path.join(dayDir(root, date), "summary.md") }))
      .filter((entry) => existsSync(entry.file));
  } catch {
    return [];
  }
}

/** The most recent day whose Next steps were written. */
export async function latestHandoff(root: string): Promise<{ date: string; nextSteps: string; blocked: string } | null> {
  for (const summary of (await summaries(root)).slice(0, 7)) {
    const text = await readFile(summary.file, "utf8");
    const nextSteps = readSection(text, "Next steps");
    if (isPlaceholder(nextSteps)) continue;
    const blocked = readSection(text, "Blocked");
    return { date: summary.date, nextSteps, blocked: isPlaceholder(blocked) ? "" : blocked };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keeping the clone current

export interface BaseUpdate {
  branch: string;
  advanced: number;
  /** Why the local branch was left alone, if it was. */
  skipped: string | null;
  /** Whether there was a remote to fetch. */
  fetched: boolean;
}

/**
 * Fetches, then fast-forwards the clone's base branch. Fast-forward only, and never with
 * uncommitted changes: nothing here may discard work. The fetch is what matters, since
 * new worktrees start from the remote's copy of the base. A clone without a remote is
 * left as it is.
 */
export async function updateBase(root: string): Promise<BaseUpdate> {
  const repo = repositoryDir(root);
  const branch = await defaultBranch(repo);
  const remote = await remoteName(repo);
  if (!remote) return { branch, advanced: 0, skipped: null, fetched: false };
  await git(repo, ["fetch", remote, "--prune"]);

  const current = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== branch) return { branch, advanced: 0, skipped: `the clone has ${current} checked out`, fetched: true };
  if ((await git(repo, ["status", "--porcelain"])) !== "") return { branch, advanced: 0, skipped: "the clone has uncommitted changes", fetched: true };
  if (!(await gitMaybe(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]))) return { branch, advanced: 0, skipped: `${remote} has no ${branch} branch`, fetched: true };

  const [ahead = "0", behind = "0"] = (await git(repo, ["rev-list", "--left-right", "--count", `${branch}...${remote}/${branch}`])).split(/\s+/);
  if (Number(ahead) > 0) return { branch, advanced: 0, skipped: `local ${branch} has ${ahead} commit(s) not on ${remote}`, fetched: true };
  if (Number(behind) > 0) await git(repo, ["merge", "--ff-only", `${remote}/${branch}`]);
  return { branch, advanced: Number(behind), skipped: null, fetched: true };
}

// ---------------------------------------------------------------------------
// Snapshot

export async function buildSnapshot(root: string, config: ProjectConfig, registry: Registry, out: Output, date: string): Promise<string> {
  const lines = [`# Snapshot · ${date}`, "", "Written by `dev day start`, and rewritten each run. History is in git.", ""];

  const handoff = await latestHandoff(root);
  if (handoff) {
    lines.push(`## Carried over from ${handoff.date}`, "", handoff.nextSteps, "");
    if (handoff.blocked) lines.push("Still blocked:", "", handoff.blocked, "");
  }

  if (existsSync(path.join(repositoryDir(root), ".git"))) {
    const base = await defaultBranch(repositoryDir(root));
    const { states, broken } = await inspectWorktrees(root, base);
    const active = states.filter((s) => !isSafeToRemove(s));
    const idle = states.filter((s) => isSafeToRemove(s));

    lines.push("## Tasks in flight", "");
    if (active.length === 0) lines.push('_None. Start one with "dev task start <ref>"._');
    for (const state of active) {
      const parts = [`${state.unmerged.length} commit${state.unmerged.length === 1 ? "" : "s"}`, `${state.dirty.length} uncommitted`];
      if (state.behind > 0) parts.push(`${base} has moved on by ${state.behind}`);
      lines.push(`- [${state.id}](tasks/${state.id}/brief.md) on \`${state.branch}\` · ${parts.join(", ")}`);
    }
    for (const { id, reason } of broken) lines.push(`- ${id}: git can't read this worktree (${reason})`);
    lines.push("");
    if (idle.length > 0) {
      lines.push(`Worktrees with nothing left in them: ${idle.map((s) => s.id).join(", ")}. Remove with \`dev task cleanup --remove\`.`, "");
    }
  }

  for (const entry of enabledServices(config, registry)) {
    const contribute = entry.service.contribute?.snapshot;
    if (!contribute) continue;
    try {
      const section = await contribute(workspaceServiceContext(root, entry, config, registry, out));
      if (section) lines.push(section.trim(), "");
    } catch (error) {
      lines.push(`## ${entry.service.title}`, "", `_Couldn't build this section: ${(error as Error).message}_`, "");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

// ---------------------------------------------------------------------------
// Day summary

export interface SessionLine {
  time: string;
  tool: string;
  file: string | null;
  task: string | null;
}

/** Commits made today in each worktree. */
async function commitsOn(root: string, date: string): Promise<Array<{ id: string; commits: string[] }>> {
  const results: Array<{ id: string; commits: string[] }> = [];
  const base = await baseRef(repositoryDir(root), await defaultBranch(repositoryDir(root)));
  const seen = new Set<string>();
  for (const id of await worktreeIds(root)) {
    const log = await gitMaybe(worktreeDir(root, id), ["log", "--oneline", "--no-merges", `${base}..HEAD`, `--since=${date} 00:00`, `--until=${date} 23:59:59`]);
    const commits = (log ?? "").split("\n").filter((line) => { const sha = line.split(" ")[0]; if (!line || seen.has(sha!)) return false; seen.add(sha!); return true; });
    if (commits.length > 0) results.push({ id, commits });
  }
  return results;
}

/** Task notes changed on that date. */
async function notesTouched(root: string, date: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    for (const id of await readdir(path.join(root, "tasks"))) {
      for (const file of await readdir(path.join(root, "tasks", id))) {
        const changed = (await stat(path.join(root, "tasks", id, file))).mtime.toLocaleDateString("en-CA");
        if (changed === date) {
          ids.push(id);
          break;
        }
      }
    }
  } catch {
    // No tasks yet.
  }
  return ids.sort();
}

export async function writeSummary(
  root: string,
  config: ProjectConfig,
  registry: Registry,
  out: Output,
  date: string,
  sessions: SessionLine[],
): Promise<string> {
  const file = path.join(dayDir(root, date), "summary.md");
  const existing = existsSync(file) ? await readFile(file, "utf8") : "";

  const facts: string[] = [];
  const commits = await commitsOn(root, date);
  const touched = await notesTouched(root, date);

  facts.push("### Sessions", "");
  facts.push(...(sessions.length > 0 ? sessions.map((s) => `- ${s.time} ${s.tool}${s.task ? ` · ${s.task}` : ""}${s.file ? ` · [transcript](${s.file})` : ""}`) : ["_None saved._"]), "");
  facts.push("### Commits", "");
  facts.push(...(commits.length > 0 ? commits.flatMap((c) => [`- ${c.id}:`, ...c.commits.map((line) => `  - ${line}`)]) : ["_None._"]), "");
  if (touched.length > 0) facts.push("### Task notes changed", "", ...touched.map((id) => `- [${id}](../../tasks/${id}/)`), "");

  for (const entry of enabledServices(config, registry)) {
    const contribute = entry.service.contribute?.dayEnd;
    if (!contribute) continue;
    try {
      const lines = await contribute(workspaceServiceContext(root, entry, config, registry, out), date);
      if (lines.length > 0) facts.push(`### ${entry.service.title}`, "", ...lines, "");
    } catch (error) {
      facts.push(`### ${entry.service.title}`, "", `_Couldn't collect: ${(error as Error).message}_`, "");
    }
  }

  const written = WRITTEN_SECTIONS.flatMap((heading) => {
    const kept = readSection(existing, heading);
    return [`## ${heading}`, "", kept || PLACEHOLDERS[heading], ""];
  });

  const text = [
    `# ${date}`,
    "",
    "The facts are rebuilt by `dev day end` each run. The written sections are kept: fill them in.",
    "",
    ...written,
    "## Facts",
    "",
    ...facts,
  ].join("\n");

  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${text.trim()}\n`);
  return file;
}
