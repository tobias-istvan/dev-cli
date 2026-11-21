/**
 * The task record's logs: findings, decisions, verification, changes and follow-ups in
 * tasks/<id>/. Every log uses one entry shape, defined here once, so what dev writes, what
 * it parses and what the skills describe can't drift:
 *
 *   ## C3 · atlassian:jira · new
 *
 *   - Item: [jira/ABC-123/ticket.md](../../jira/ABC-123/ticket.md)
 *   - Changed: status: In Progress → In Review
 *
 *   Free text.
 *
 * A heading with an id, a kind where the log has one, and a status; then fields as a list;
 * then free text. Ids are never reused.
 */

export interface LogFormat {
  file: string;
  title: string;
  /** What the file says about itself, under its title. */
  intro: string;
  prefix: string;
  statuses: readonly string[];
}

export const CHANGES: LogFormat = {
  file: "changes.md",
  title: "Source changes",
  intro:
    "Written by `dev sync` when one of this task's sources changes. For each `new` entry, work out what it\n" +
    "means for the brief, plan and verification plan, then set its status to `reviewed` and add\n" +
    "`- Led to:` with the findings or decisions it led to, or `nothing`.",
  prefix: "C",
  statuses: ["new", "reviewed"],
};

export interface Entry {
  /** The number after the prefix. */
  number: number;
  kind?: string;
  status: string;
  /** In order, each written as "- Name: value". */
  fields: Array<[string, string]>;
  text?: string;
}

const HEADING = (prefix: string) => new RegExp(String.raw`^## ${prefix}(\d+)\b`, "gm");

/** The next free id number in a log's text: one more than the highest, so ids are never reused. */
export function nextNumber(format: LogFormat, text: string): number {
  let highest = 0;
  for (const match of text.matchAll(HEADING(format.prefix))) highest = Math.max(highest, Number(match[1]));
  return highest + 1;
}

export function renderEntry(format: LogFormat, entry: Entry): string {
  const heading = [`${format.prefix}${entry.number}`, ...(entry.kind ? [entry.kind] : []), entry.status].join(" · ");
  const fields = entry.fields.map(([name, value]) => `- ${name}: ${value.replace(/\r?\n/g, " ")}`);
  return [`## ${heading}`, "", ...fields, ...(entry.text ? ["", entry.text.trim()] : [])].join("\n");
}

/** A new log file's opening: its title and what it's for. */
export function logHeader(format: LogFormat): string {
  return `# ${format.title}\n\n${format.intro}\n`;
}
