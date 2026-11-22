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
 * A heading with an id, a kind where the log has one, and a status where it has them; then
 * fields as a list; then free text. Ids are never reused.
 */

export interface FieldFormat {
  name: string;
  /** What it holds, for the skills. */
  meaning: string;
  /** The only values it takes, when it's a choice. */
  values?: readonly string[];
  /** The status that needs it. */
  requiredWhen?: string;
  /** Whether it names other entries by id, like "F3, D5". */
  refers?: boolean;
}

export interface LogFormat {
  file: string;
  title: string;
  /** What the file says about itself, under its title. */
  intro: string;
  prefix: string;
  /** None for a log whose entries have no status. */
  statuses: readonly string[];
  /** The kinds it takes; "free" for any text, like a service or a criterion; absent for none. */
  kinds?: readonly string[] | "free";
  /** What the kind is, for the skills. */
  kindMeaning?: string;
  fields: readonly FieldFormat[];
  /** A well-formed entry, shown in the skills. */
  example: Entry;
}

export const FINDINGS: LogFormat = {
  file: "findings.md",
  title: "Findings",
  intro: "Gaps, conflicts and missing information found in the task's sources or the code.",
  prefix: "F",
  kinds: ["gap", "conflict", "missing"],
  kindMeaning: "gap: something the sources don't say; conflict: two sources disagree; missing: something referred to isn't there",
  statuses: ["open", "answered", "assumed"],
  fields: [
    { name: "Sources", meaning: "Where it was found: workspace files, with the section" },
    { name: "Blocks", meaning: "Whether the work stops until it's answered", values: ["yes", "no"] },
    { name: "Answer from", meaning: "Who can answer it" },
    { name: "Answer", meaning: "The answer, and who gave it" },
  ],
  example: {
    number: 3,
    kind: "conflict",
    status: "open",
    fields: [
      ["Sources", "jira/ABC-123/ticket.md (Acceptance criteria), figma/abc-12-34/design.md"],
      ["Blocks", "yes"],
      ["Answer from", "the ticket's reporter"],
    ],
    text: "The ticket sorts the list by date; the design sorts it by name.",
  },
};

export const DECISIONS: LogFormat = {
  file: "decisions.md",
  title: "Decisions",
  intro: "Choices made, why, the alternatives, and the findings they resolve.",
  prefix: "D",
  statuses: [],
  fields: [
    { name: "Resolves", meaning: "The findings it resolves, by id", refers: true },
    { name: "Why", meaning: "The reason for the choice" },
    { name: "Alternatives", meaning: "What else was considered" },
  ],
  example: {
    number: 2,
    status: "",
    fields: [
      ["Resolves", "F3"],
      ["Why", "the reporter answered on the ticket: by date"],
      ["Alternatives", "by name, as the design shows"],
    ],
    text: "Sort the list by date, newest first.",
  },
};

export const VERIFICATION: LogFormat = {
  file: "verification.md",
  title: "Verification",
  intro: "For each acceptance criterion: how it's checked, by whom, the evidence expected, then the result.",
  prefix: "V",
  kinds: "free",
  kindMeaning: "the criterion it checks",
  statuses: ["planned", "passed", "failed", "needs-person"],
  fields: [
    { name: "How", meaning: "How it's checked" },
    { name: "By", meaning: "Who or what checks it: a test, the agent, a person" },
    { name: "Expected", meaning: "The evidence expected" },
    { name: "Evidence", meaning: "What was found, linking to files in evidence/" },
  ],
  example: {
    number: 1,
    kind: "The list sorts by date, newest first",
    status: "planned",
    fields: [
      ["How", "a unit test of the sort, then the page with three orders"],
      ["By", "test, then the agent"],
      ["Expected", "the test passes; a screenshot with the newest order first"],
    ],
  },
};

export const CHANGES: LogFormat = {
  file: "changes.md",
  title: "Source changes",
  intro:
    "Written by `dev sync` when one of this task's sources changes. For each `new` entry, work out what it\n" +
    "means for the brief, plan and verification plan, then set its status to `reviewed` and add\n" +
    "`- Led to:` with the findings or decisions it led to, or `nothing`.",
  prefix: "C",
  kinds: "free",
  kindMeaning: "the source's service",
  statuses: ["new", "reviewed"],
  fields: [
    { name: "Item", meaning: "The changed item's file" },
    { name: "Changed", meaning: "What changed" },
    { name: "Report", meaning: "The sync's change report" },
    { name: "Recorded", meaning: "When the sync recorded it" },
    { name: "Reopened", meaning: "Whether the task's own ticket went from done back to open. Once the task is finished, `dev task start` starts the next round", values: ["yes"] },
    { name: "Led to", meaning: "The findings or decisions it led to, by id, or nothing", requiredWhen: "reviewed", refers: true },
  ],
  example: {
    number: 3,
    kind: "atlassian:jira",
    status: "reviewed",
    fields: [
      ["Item", "[jira/ABC-123/ticket.md](../../jira/ABC-123/ticket.md)"],
      ["Changed", "section changed: Acceptance criteria"],
      ["Led to", "F4, D3"],
    ],
    text: "ABC-123 · Sort the order list",
  },
};

export const FOLLOW_UPS: LogFormat = {
  file: "follow-ups.md",
  title: "Follow-ups",
  intro: "Issues found but not fixed in this task.",
  prefix: "O",
  statuses: ["noted", "filed"],
  fields: [
    { name: "Found in", meaning: "Where it was found: files, or the step of the work" },
    { name: "Filed as", meaning: "The issue it was filed as", requiredWhen: "filed" },
  ],
  example: {
    number: 1,
    status: "noted",
    fields: [["Found in", "src/orders/api.ts, while building paging"]],
    text: "The orders API ignores page sizes over 100 without saying so.",
  },
};

/** Every log in a task folder, in the order the record is read. */
export const LOGS = [FINDINGS, DECISIONS, VERIFICATION, CHANGES, FOLLOW_UPS] as const;

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
  const heading = [`${format.prefix}${entry.number}`, ...(entry.kind ? [entry.kind] : []), ...(entry.status ? [entry.status] : [])].join(" · ");
  const fields = entry.fields.map(([name, value]) => `- ${name}: ${value.replace(/\r?\n/g, " ")}`);
  return [`## ${heading}`, "", ...fields, ...(entry.text ? ["", entry.text.trim()] : [])].join("\n");
}

/** A new log file's opening: its title and what it's for. */
export function logHeader(format: LogFormat): string {
  return `# ${format.title}\n\n${format.intro}\n`;
}

/** A log's format as the skills describe it, from this definition, so they can't drift. */
export function describeFormat(format: LogFormat): string {
  const shape = [`${format.prefix}<n>`, ...(format.kinds ? ["<kind>"] : []), ...(format.statuses.length > 0 ? ["<status>"] : [])].join(" · ");
  const fields = format.fields.map((spec) => {
    const notes = [...(spec.values ? [`${spec.values.join(" or ")}`] : []), ...(spec.requiredWhen ? [`needed once it's \`${spec.requiredWhen}\``] : [])];
    return `  - \`${spec.name}\`: ${spec.meaning}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
  });
  return [
    `**\`${format.file}\`**: ${(format.intro.match(/^[\s\S]*?\.(?=\s|$)/)?.[0] ?? format.intro).replace(/\s*\n\s*/g, " ")}`,
    "",
    `- Heading: \`## ${shape}\`. Number from one more than the highest id in the file; never reuse an id.`,
    ...(format.kinds ? [`- Kind: ${Array.isArray(format.kinds) ? `${format.kinds.map((k) => `\`${k}\``).join(", ")}. ` : ""}${format.kindMeaning}`] : []),
    ...(format.statuses.length > 0 ? [`- Status: ${format.statuses.map((s) => `\`${s}\``).join(", ")}`] : []),
    "- Fields, as `- Name: value` lines under the heading, then free text:",
    ...fields,
    `- A new file starts with \`# ${format.title}\` and a line saying what it holds.`,
    "",
    "```markdown",
    renderEntry(format, format.example),
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reading

export interface ParsedEntry extends Entry {
  /** Like "F3". */
  id: string;
  /** The heading's line, from 1. */
  line: number;
}

export interface LogWarning {
  line: number;
  message: string;
}

/** Ids like F3 or D5 in a field's value. */
export const ENTRY_ID = /\b([A-Z])(\d+)\b/g;

/** A field's value by name, ignoring case. */
export function field(entry: Entry, name: string): string | undefined {
  return entry.fields.find(([each]) => each.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * A log's entries, and what's wrong with them. Nothing is an error: a malformed entry is still
 * read as well as it can be, so other entries can refer to it.
 */
export function parseLog(format: LogFormat, text: string): { entries: ParsedEntry[]; warnings: LogWarning[] } {
  const entries: ParsedEntry[] = [];
  const warnings: LogWarning[] = [];
  const lines = text.split(/\r?\n/);
  const shape = [`${format.prefix}<n>`, ...(format.kinds ? ["<kind>"] : []), ...(format.statuses.length > 0 ? ["<status>"] : [])].join(" · ");
  let current: { entry: ParsedEntry; body: string[] } | null = null;
  let fenced = false;

  const finish = () => {
    if (!current) return;
    const { entry, body } = current;
    let i = 0;
    while (i < body.length && body[i]!.trim() === "") i++;
    for (; i < body.length; i++) {
      const match = body[i]!.match(/^[-*] ([^:]+?):\s*(.*)$/);
      if (!match) break;
      entry.fields.push([match[1]!.trim(), match[2]!.trim()]);
    }
    const text = body.slice(i).join("\n").trim();
    if (text) entry.text = text;
    for (const spec of format.fields) {
      const value = field(entry, spec.name);
      if (spec.values && value !== undefined && !spec.values.includes(value.toLowerCase())) {
        warnings.push({ line: entry.line, message: `${entry.id}: ${spec.name} is "${value}", not ${spec.values.join(" or ")}` });
      }
      if (spec.requiredWhen && entry.status === spec.requiredWhen && !value) {
        warnings.push({ line: entry.line, message: `${entry.id} is ${entry.status} but has no "- ${spec.name}:"` });
      }
    }
    entries.push(entry);
    current = null;
  };

  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || !line.startsWith("## ")) {
      current?.body.push(line);
      continue;
    }
    finish();
    const number = index + 1;
    const parts = line.slice(3).split(" · ").map((part) => part.trim());
    const id = parts[0]!.match(new RegExp(`^${format.prefix}(\\d+)$`));
    if (!id) {
      warnings.push({ line: number, message: `"${line}" isn't an entry: entries start "## ${shape}"` });
      continue;
    }
    const rest = parts.slice(1);
    const status = format.statuses.length > 0 ? rest.pop() : undefined;
    const kind = format.kinds ? rest.join(" · ") : undefined;
    const entry: ParsedEntry = { id: parts[0]!, number: Number(id[1]), line: number, status: status ?? "", ...(kind ? { kind } : {}), fields: [] };
    const problems: string[] = [];
    if (format.statuses.length > 0 && !status) problems.push(`no status, one of ${format.statuses.join(", ")}`);
    else if (status && !format.statuses.includes(status)) problems.push(`unknown status "${status}", not one of ${format.statuses.join(", ")}`);
    if (format.kinds && !kind) problems.push(`no kind (${format.kindMeaning})`);
    else if (Array.isArray(format.kinds) && kind && !format.kinds.includes(kind)) problems.push(`unknown kind "${kind}", not one of ${format.kinds.join(", ")}`);
    if (!format.kinds && rest.length > 0) problems.push(`the heading has more than "## ${shape}"`);
    if (entries.some((other) => other.number === entry.number)) problems.push(`${entry.id} is used twice; ids are never reused`);
    for (const problem of problems) warnings.push({ line: number, message: `${entry.id}: ${problem}` });
    current = { entry, body: [] };
  }
  finish();
  return { entries, warnings };
}
