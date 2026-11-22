import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { splitFrontMatter } from "./front-matter.ts";
import { CHANGES, DECISIONS, ENTRY_ID, field, FINDINGS, FOLLOW_UPS, type LogFormat, LOGS, parseLog, type ParsedEntry, VERIFICATION } from "./record.ts";
import { taskDir } from "./tasks.ts";

/**
 * A task's state, worked out from its record in tasks/<id>/ each time it's asked for: there's
 * no status file to drift. Agents write the files; this only reads them, and what's malformed
 * is a warning, never an error.
 */

export interface RecordWarning {
  /** Relative to the workspace root. */
  file: string;
  line: number | null;
  message: string;
}

export interface LogState {
  file: string;
  /** Whether the file is there. */
  exists: boolean;
  /** Entry ids by status, or under "" for a log without statuses. */
  byStatus: Record<string, string[]>;
}

export interface TaskRecord {
  id: string;
  /** Whether tasks/<id>/ is there. */
  exists: boolean;
  brief: boolean;
  round: number;
  pr: number | null;
  /** The day the round's PR merged, from the brief. */
  finished: string | null;
  /** Unreviewed changes that reopened the task's ticket: `dev task start` starts the next round. */
  reopened: string[];
  /** The brief's `sources:`. */
  sources: string[];
  logs: { findings: LogState; decisions: LogState; verification: LogState; changes: LogState; followUps: LogState };
  /** Open findings that block the work. */
  blocking: string[];
  /** From a brief written before findings.md: the items under its "Open questions", when there's no findings.md. */
  briefQuestions: string[] | null;
  /** From the brief's acceptance criteria, when there's no verification.md. */
  briefCriteria: { total: number; ticked: number } | null;
  warnings: RecordWarning[];
}

const KEYS = new Map<LogFormat, keyof TaskRecord["logs"]>([
  [FINDINGS, "findings"],
  [DECISIONS, "decisions"],
  [VERIFICATION, "verification"],
  [CHANGES, "changes"],
  [FOLLOW_UPS, "followUps"],
]);

/** A brief section's list items, without the template's placeholders. */
function sectionItems(body: string, heading: string): string[] {
  const section = body.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))?.[1] ?? "";
  return [...section.matchAll(/^\s*[-*] (.+)$/gm)].map((m) => m[1]!.trim()).filter((item) => !/^(\[[ xX]\] )?…$/.test(item) && !item.startsWith("_"));
}

export async function readRecord(root: string, id: string): Promise<TaskRecord> {
  const dir = taskDir(root, id);
  const relative = (name: string) => path.posix.join("tasks", id, name);
  const warnings: RecordWarning[] = [];
  const record: TaskRecord = {
    id,
    exists: existsSync(dir),
    brief: false,
    round: 1,
    pr: null,
    finished: null,
    reopened: [],
    sources: [],
    logs: Object.fromEntries([...KEYS].map(([format, key]) => [key, { file: relative(format.file), exists: false, byStatus: {} }])) as TaskRecord["logs"],
    blocking: [],
    briefQuestions: null,
    briefCriteria: null,
    warnings,
  };

  let body = "";
  try {
    const text = await readFile(path.join(dir, "brief.md"), "utf8");
    record.brief = true;
    const parsed = splitFrontMatter(text);
    body = parsed.body;
    const data = parsed.data ?? {};
    const warn = (message: string) => warnings.push({ file: relative("brief.md"), line: null, message });
    if (!parsed.data) warn("the front matter can't be read");
    if (data.round !== undefined) {
      if (Number.isInteger(data.round) && (data.round as number) >= 1) record.round = data.round as number;
      else warn(`round is ${JSON.stringify(data.round)}, not a whole number from 1`);
    }
    if (data.pr !== undefined && data.pr !== null) {
      if (Number.isInteger(data.pr) && (data.pr as number) >= 1) record.pr = data.pr as number;
      else warn(`pr is ${JSON.stringify(data.pr)}, not a pull or merge request number`);
    }
    if (data.finished !== undefined && data.finished !== null) {
      const finished = data.finished instanceof Date ? data.finished.toISOString().slice(0, 10) : String(data.finished);
      if (/^\d{4}-\d{2}-\d{2}$/.test(finished)) record.finished = finished;
      else warn(`finished is ${JSON.stringify(data.finished)}, not a date like 2026-11-20`);
    }
    if (data.sources !== undefined && data.sources !== null) {
      if (Array.isArray(data.sources) && data.sources.every((s) => typeof s === "string")) record.sources = data.sources as string[];
      else warn("sources isn't a list of workspace files");
    }
    for (const file of record.sources) {
      if (!existsSync(path.join(root, file))) warn(`sources lists ${file}, which isn't in the workspace`);
    }
  } catch {
    // No brief: a review worktree, or one removed by hand.
  }

  const entries = new Map<string, ParsedEntry>();
  const parsed: Array<[LogFormat, ParsedEntry[]]> = [];
  for (const [format, key] of KEYS) {
    let text: string;
    try {
      text = await readFile(path.join(dir, format.file), "utf8");
    } catch {
      continue;
    }
    const log = parseLog(format, text);
    const state = record.logs[key];
    state.exists = true;
    for (const entry of log.entries) {
      (state.byStatus[entry.status] ??= []).push(entry.id);
      entries.set(entry.id, entry);
    }
    for (const warning of log.warnings) warnings.push({ file: state.file, ...warning });
    parsed.push([format, log.entries]);
  }

  // What only the whole record can check: references between entries.
  const resolved = new Set<string>();
  for (const [format, list] of parsed) {
    for (const entry of list) {
      for (const spec of format.fields.filter((f) => f.refers)) {
        const value = field(entry, spec.name) ?? "";
        for (const match of value.matchAll(ENTRY_ID)) {
          if (!LOGS.some((log) => log.prefix === match[1])) continue;
          if (!entries.has(match[0])) warnings.push({ file: relative(format.file), line: entry.line, message: `${entry.id}: ${spec.name} names ${match[0]}, which isn't in the record` });
          if (format === DECISIONS) resolved.add(match[0]);
        }
      }
    }
  }
  for (const [format, list] of parsed) {
    if (format !== FINDINGS && format !== CHANGES) continue;
    for (const entry of list) {
      if (entry.status === "new" && field(entry, "Reopened")?.toLowerCase() === "yes") record.reopened.push(entry.id);
      if (entry.status === "open" && field(entry, "Blocks")?.toLowerCase() === "yes") record.blocking.push(entry.id);
      if (entry.status === "assumed" && !resolved.has(entry.id)) {
        warnings.push({ file: relative(FINDINGS.file), line: entry.line, message: `${entry.id} is assumed, but no decision resolves it to state the assumption` });
      }
    }
  }

  if (record.brief && !record.logs.findings.exists) record.briefQuestions = sectionItems(body, "Open questions");
  if (record.brief && !record.logs.verification.exists) {
    const criteria = sectionItems(body, "Acceptance criteria");
    record.briefCriteria = { total: criteria.length, ticked: criteria.filter((c) => /^\[[xX]\]/.test(c)).length };
  }
  return record;
}

/** Every task folder's id. */
export async function recordIds(root: string): Promise<string[]> {
  try {
    return (await readdir(path.join(root, "tasks"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

const ids = (list: string[] | undefined) => (list && list.length > 0 ? ` (${list.join(", ")})` : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The record as lines for `dev task status <id>`. */
export function describeRecord(record: TaskRecord): string[] {
  const lines: string[] = [];
  const { findings, decisions, verification, changes, followUps } = record.logs;
  if (record.brief) lines.push(`Round ${record.round}${record.pr ? ` · PR #${record.pr}${record.finished ? `, merged ${record.finished}` : ""}` : ""}`);
  else lines.push(record.exists ? "No brief.md" : `No tasks/${record.id}/`);
  if (record.reopened.length > 0) lines.push(`Reopened${ids(record.reopened)}: "dev task start ${record.id}" starts round ${record.round + 1}`);

  if (findings.exists) {
    const open = findings.byStatus.open ?? [];
    const parts = [`${open.length} open${ids(open)}`];
    if (record.blocking.length > 0) parts.push(`${record.blocking.length} blocking${ids(record.blocking)}`);
    if (findings.byStatus.assumed?.length) parts.push(`${findings.byStatus.assumed.length} assumed${ids(findings.byStatus.assumed)}`);
    if (findings.byStatus.answered?.length) parts.push(`${findings.byStatus.answered.length} answered`);
    lines.push(`Findings: ${parts.join(", ")}`);
  } else if (record.briefQuestions && record.briefQuestions.length > 0) {
    lines.push(`Open questions in the brief, from before findings.md: ${record.briefQuestions.length}${record.briefQuestions.map((q) => `\n  ${q}`).join("")}`);
  } else if (record.exists) {
    lines.push("Findings: none yet");
  }

  if (decisions.exists) lines.push(`Decisions: ${(decisions.byStatus[""] ?? []).length}`);

  if (changes.exists) {
    const fresh = changes.byStatus.new ?? [];
    lines.push(fresh.length > 0 ? `Source changes to review: ${fresh.join(", ")}` : `Source changes: none to review (${(changes.byStatus.reviewed ?? []).length} reviewed)`);
  }

  if (verification.exists) {
    const all = Object.values(verification.byStatus).flat();
    const passed = verification.byStatus.passed ?? [];
    const parts = [`${passed.length} of ${plural(all.length, "check")} passed`];
    for (const [status, label] of [["failed", "failed"], ["needs-person", "needs a person"], ["planned", "planned"]] as const) {
      if (verification.byStatus[status]?.length) parts.push(`${label}: ${verification.byStatus[status].join(", ")}`);
    }
    lines.push(`Verification: ${parts.join(" · ")}`);
  } else if (record.briefCriteria) {
    const { total, ticked } = record.briefCriteria;
    lines.push(`Verification: no plan yet${total > 0 ? ` (the brief lists ${plural(total, "criterion", "criteria")}, ${ticked} ticked)` : ""}`);
  }

  if (followUps.exists) {
    const noted = followUps.byStatus.noted ?? [];
    lines.push(noted.length > 0 ? `Follow-ups to file: ${noted.join(", ")}` : `Follow-ups: none to file (${(followUps.byStatus.filed ?? []).length} filed)`);
  }

  if (record.warnings.length > 0) {
    lines.push(`Warnings: ${record.warnings.length}`);
    for (const w of record.warnings) lines.push(`  ${w.file}${w.line ? `:${w.line}` : ""}  ${w.message}`);
  }
  return lines;
}

/** What needs attention, short, for one line per task in `dev task status`. */
export function recordNotes(record: TaskRecord): string[] {
  const notes: string[] = [];
  if (record.round > 1) notes.push(`round ${record.round}`);
  if (record.reopened.length > 0) notes.push("reopened");
  if (record.blocking.length > 0) notes.push(`${record.blocking.length} blocking`);
  const fresh = record.logs.changes.byStatus.new?.length ?? 0;
  if (fresh > 0) notes.push(`${plural(fresh, "change")} to review`);
  const failed = record.logs.verification.byStatus.failed?.length ?? 0;
  if (failed > 0) notes.push(`${failed} failed`);
  if (record.warnings.length > 0) notes.push(plural(record.warnings.length, "warning"));
  return notes;
}
