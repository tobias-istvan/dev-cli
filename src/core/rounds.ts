import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import type { ChangeRequest, Output } from "../plugins/types.ts";
import { workspaceServiceContext } from "./context.ts";
import { atomicWrite } from "./files.ts";
import { splitFrontMatter } from "./front-matter.ts";
import type { ProjectConfig } from "./project-config.ts";
import { logHeader, parseLog, renderEntry, VERIFICATION } from "./record.ts";
import { taskDir } from "./tasks.ts";

/**
 * Rounds: one task is one ticket and one folder, with one PR at a time. dev finds the task's
 * PR and writes it into the brief, with the day it merged as `finished`. A ticket reopened
 * after that gets a new round: the round's PR files move to history/<n>/ and the task starts
 * again on a new branch, its logs carrying on.
 */

export const DEFAULT_WATCH_DAYS = 30;

/** The files that belong to one PR, moved to history/<n>/ when the next round starts. */
const PER_PR = ["pr-description.md", "verification.md", "evidence"];
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---/;

function dateText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** Whether `dev sync` still adds source changes to a task: always until it's finished, then for conventions.watchDays. */
export function watching(brief: string, config: ProjectConfig, now = new Date()): boolean {
  const finished = dateText(splitFrontMatter(brief).data?.finished);
  if (!finished) return true;
  const until = new Date(`${finished}T00:00:00Z`);
  until.setUTCDate(until.getUTCDate() + (config.conventions.watchDays ?? DEFAULT_WATCH_DAYS));
  return now.toISOString().slice(0, 10) <= until.toISOString().slice(0, 10);
}

export interface BriefState {
  round: number;
  pr: number | null;
  finished: string | null;
  branch: string | null;
}

export async function readBrief(root: string, id: string): Promise<BriefState | null> {
  let text: string;
  try {
    text = await readFile(path.join(taskDir(root, id), "brief.md"), "utf8");
  } catch {
    return null;
  }
  const data = splitFrontMatter(text).data ?? {};
  return {
    round: Number.isInteger(data.round) && (data.round as number) >= 1 ? (data.round as number) : 1,
    pr: Number.isInteger(data.pr) && (data.pr as number) >= 1 ? (data.pr as number) : null,
    finished: dateText(data.finished),
    branch: typeof data.branch === "string" ? data.branch : null,
  };
}

/**
 * Sets fields in the brief's front matter, a line each, leaving every other line as it was
 * written. Null removes a field. Returns whether the brief changed.
 */
export async function setBriefFields(root: string, id: string, fields: Record<string, string | number | null>): Promise<boolean> {
  const file = path.join(taskDir(root, id), "brief.md");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  const match = text.match(FENCE);
  if (!match) return false;
  const lines = match[1]!.split(/\r?\n/);
  for (const [name, value] of Object.entries(fields)) {
    const at = lines.findIndex((line) => line.startsWith(`${name}:`));
    const line = `${name}: ${typeof value === "number" ? value : JSON.stringify(value)}`;
    if (value === null) {
      if (at >= 0) lines.splice(at, 1);
    } else if (at >= 0) {
      lines[at] = line;
    } else {
      // Next to the round, where the template puts them.
      const round = lines.findIndex((each) => each.startsWith("round:"));
      const before = lines.findIndex((each) => each.startsWith("sources:"));
      lines.splice(round >= 0 ? round + 1 : before >= 0 ? before : lines.length, 0, line);
    }
  }
  const next = `---\n${lines.join("\n")}\n---${text.slice(match[0].length)}`;
  if (next === text) return false;
  await atomicWrite(file, next);
  return true;
}

export interface TaskPr {
  change: ChangeRequest;
  /** Whether the brief was updated. */
  updated: boolean;
}

/**
 * Asks the versioning service for the newest PR or MR on the task's branch and records it in
 * the brief: `pr`, and `finished` once it's merged. Best effort: null without a versioning
 * service that can say, a branch, or a PR.
 */
export async function findTaskPr(root: string, config: ProjectConfig, registry: Registry, out: Output, id: string): Promise<TaskPr | null> {
  const brief = await readBrief(root, id);
  const entry = config.versioning ? registry.service(config.versioning.service) : undefined;
  const find = entry?.service.versioning?.changeRequests;
  if (!brief?.branch || !config.versioning || !entry || !find) return null;
  const context = workspaceServiceContext(root, entry, config, registry, out);
  const change = (await find(context, context.credentials(), config.versioning.repo, brief.branch))[0];
  if (!change) return null;
  const finished = change.state === "merged" ? (dateText(change.mergedAt) ?? new Date().toLocaleDateString("en-CA")) : null;
  const updated = await setBriefFields(root, id, { pr: change.number, finished });
  return { change, updated };
}

/**
 * The same, for several tasks, never failing: what can't be found is left as it is. Returns
 * the tasks whose brief changed.
 */
export async function findTaskPrs(root: string, config: ProjectConfig, registry: Registry, out: Output, ids: string[]): Promise<{ updated: string[]; failed: string | null }> {
  const updated: string[] = [];
  let failed: string | null = null;
  for (const id of ids) {
    try {
      if ((await findTaskPr(root, config, registry, out, id))?.updated) updated.push(id);
    } catch (error) {
      failed ??= (error as Error).message;
    }
  }
  return { updated, failed };
}

/** A verification plan for the next round: every check again, as planned, without the last round's evidence. */
export function replan(text: string): string {
  const keep = new Set(["how", "by", "expected"]);
  const entries = parseLog(VERIFICATION, text).entries.map((entry) =>
    renderEntry(VERIFICATION, { ...entry, status: "planned", fields: entry.fields.filter(([name]) => keep.has(name.toLowerCase())) }),
  );
  return `${logHeader(VERIFICATION)}${entries.length > 0 ? `\n${entries.join("\n\n")}\n` : ""}`;
}

/**
 * Ends round n of a task: its PR files move to history/<n>/, the verification plan starts
 * again, and the brief moves to round n + 1 on the new branch. Logs carry on. Returns what
 * was moved, relative to the task folder.
 */
export async function startNextRound(root: string, id: string, next: { branch: string; reason: string }): Promise<{ round: number; moved: string[] }> {
  const dir = taskDir(root, id);
  const brief = await readBrief(root, id);
  if (!brief) throw new Error(`tasks/${id}/brief.md can't be read.`);
  const round = brief.round;
  const history = path.join(dir, "history", String(round));
  if (existsSync(history)) throw new Error(`tasks/${id}/history/${round}/ is already there, so round ${round} looks archived. Check the brief's round.`);
  await mkdir(history, { recursive: true });

  const moved: string[] = [];
  for (const name of PER_PR) {
    if (!existsSync(path.join(dir, name))) continue;
    await rename(path.join(dir, name), path.join(history, name));
    moved.push(name);
  }
  if (moved.includes("verification.md")) {
    const plan = replan(await readFile(path.join(history, "verification.md"), "utf8"));
    await writeFile(path.join(dir, "verification.md"), plan);
  }
  const facts = [
    brief.pr ? `- PR: #${brief.pr}` : "- PR: not found",
    ...(brief.finished ? [`- Merged: ${brief.finished}`] : []),
    ...(brief.branch ? [`- Branch: \`${brief.branch}\``] : []),
  ];
  await writeFile(
    path.join(history, "README.md"),
    `# Round ${round}\n\n${facts.join("\n")}\n\nThis round's PR files, kept as they were. The task's top-level files describe the current round.\n`,
  );

  await setBriefFields(root, id, { round: round + 1, branch: next.branch, pr: null, finished: null });
  const progress = path.join(dir, "progress.md");
  if (existsSync(progress)) {
    const when = new Date().toLocaleDateString("en-CA");
    await appendFile(progress, `\nRound ${round + 1} started ${when}: ${next.reason}. Round ${round}'s PR files are in history/${round}/.\n`);
  }
  return { round: round + 1, moved };
}

