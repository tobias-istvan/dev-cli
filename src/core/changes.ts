import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import { dayDir, today } from "./day.ts";
import { atomicWrite, atomicWriteSync, safePath } from "./files.ts";
import { splitFrontMatter } from "./front-matter.ts";
import { serviceFiles } from "./indexes.ts";
import type { ProjectConfig } from "./project-config.ts";
import { CHANGES, logHeader, nextNumber, renderEntry } from "./record.ts";
import { enabledServices } from "./scaffold.ts";

/**
 * Source changes: what a sync changed in the synced items, and which tasks it affects.
 *
 * dev keeps a baseline of every item as the last finished sync left it, in
 * .dev/state/items.json. At the end of each sync, after links are pointed at local copies,
 * the items on disk are compared with it, the differences are recorded, and the baseline
 * moves on. That covers every way a plugin writes, and a sync that's interrupted loses
 * nothing: the next one compares with the same baseline.
 *
 * The `updated` rule: a field or section that changed while the item's `updated` didn't is
 * dev rendering it differently, not a change in the source, and isn't recorded. Moves,
 * scope changes, deletions and new comments always are.
 */

export interface ItemState {
  file: string;
  updated: string;
  /** Front matter, except `synced` and `updated`. */
  fields: Record<string, unknown>;
  /** Each section's heading, with a short hash of its text. */
  sections: Record<string, string>;
  /** From a "Comments (N)" heading, which every task source writes. */
  comments?: number;
}

interface Baseline {
  version: 1;
  synced: string;
  items: Record<string, ItemState>;
}

export interface Change {
  key: string;
  service: string;
  id: string;
  title: string;
  /** Where it is now, or was, for one that's gone. Relative to the workspace root. */
  file: string;
  /** What changed, one line each, like "status: In Progress → In Review". */
  details: string[];
  /** The tasks it affects. */
  tasks: string[];
}

export interface ChangeResult {
  /** Null on the first run, which only sets the baseline. */
  changes: Change[] | null;
  report: string | null;
}

const VERSION = 1;
/** Compared whether or not `updated` moved: they change without the source changing. */
const ALWAYS = new Set(["inScope", "via", "gone"]);
const SKIPPED = new Set(["synced", "updated"]);
const COMMENTS = /^comments \((\d+)\)$/i;
const OUTSIDE_SECTION = /\n*<!-- dev:outside-scope -->[\s\S]*$/;
/** A link the localizer made local keeps its address as the title: [x](../a.md "https://…"). */
const LOCALIZED = /\]\((?!https?:)([^()\s]+) "(https?:\/\/[^"\s]+)"\)/g;
const LOCAL_LINK = /\]\((?!https?:|mailto:|#)<?([^()\s>]+)>?(?:\s+"[^"]*")?\)/g;

function baselineFile(root: string): string {
  return safePath(root, ".dev/state/items.json");
}

function readBaseline(root: string): Baseline | null {
  try {
    const value = JSON.parse(readFileSync(baselineFile(root), "utf8")) as Baseline;
    return value?.version === VERSION && value.items && typeof value.items === "object" ? value : null;
  } catch {
    return null;
  }
}

function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Each section's text by heading, as the source wrote it: local links back to their addresses, dev's own notes left out. */
function sections(body: string): { sections: Record<string, string>; comments?: number } {
  const text = body.replace(OUTSIDE_SECTION, "").replace(LOCALIZED, "]($2)");
  const result: Record<string, string> = {};
  let comments: number | undefined;
  let heading = "";
  let lines: string[] = [];
  let fence = false;
  const flush = () => {
    const content = lines.join("\n").trim();
    if (heading || content) {
      let name = heading;
      for (let n = 2; name in result; n++) name = `${heading} (${n})`;
      result[name] = hash(content);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    heading = match[1]!;
    const count = heading.match(COMMENTS);
    if (count) {
      comments = (comments ?? 0) + Number(count[1]);
      heading = "Comments";
    }
    lines = [];
  }
  flush();
  return { sections: result, ...(comments !== undefined ? { comments } : {}) };
}

interface Scanned {
  key: string;
  state: ItemState;
  /** Files the body links to, relative to the workspace root. */
  links: string[];
}

/** An item's state from its file, or null for a file that isn't a synced item. */
export function readItem(file: string, text: string): Scanned | null {
  const { data, body } = splitFrontMatter(text);
  if (!data || typeof data.service !== "string" || (typeof data.id !== "string" && typeof data.id !== "number")) return null;
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) if (!SKIPPED.has(name)) fields[name] = plain(value);
  const links = new Set<string>();
  for (const match of body.matchAll(LOCAL_LINK)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURI(match[1]!).split("#")[0]!));
    if (!target.startsWith("..") && target.endsWith(".md")) links.add(target);
  }
  return {
    key: `${data.service}:${data.id}`,
    state: { file, updated: String(plain(data.updated) ?? ""), fields, ...sections(body) },
    links: [...links],
  };
}

/** Every synced item of the enabled connected services, as it is on disk now. */
function scan(root: string, config: ProjectConfig, registry: Registry): Map<string, Scanned> {
  const items = new Map<string, Scanned>();
  for (const entry of enabledServices(config, registry)) {
    if (entry.service.role !== "connected") continue;
    for (const file of serviceFiles(root, entry.service)) {
      let text: string;
      try {
        text = readFileSync(path.join(root, file), "utf8");
      } catch {
        continue;
      }
      const item = readItem(file, text);
      if (item && !items.has(item.key)) items.set(item.key, item);
    }
  }
  return items;
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return "none";
  const text = Array.isArray(value) ? value.map((v) => String(v)).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What changed between two states of one item, following the `updated` rule. Empty when nothing counts. */
export function compareItem(before: ItemState, after: ItemState): string[] {
  const details: string[] = [];
  if (before.file !== after.file) details.push(`moved from ${before.file}`);
  if (!same(before.fields.inScope, after.fields.inScope)) details.push(after.fields.inScope === false ? "left the scope" : "came into the scope");
  if (after.fields.gone === true && before.fields.gone !== true) details.push("deleted in the service");
  else if (before.fields.gone === true && after.fields.gone !== true) details.push("back in the service");
  if ((after.comments ?? 0) > (before.comments ?? 0)) {
    const added = (after.comments ?? 0) - (before.comments ?? 0);
    details.push(`${added} comment${added === 1 ? "" : "s"} added`);
  }
  if (before.updated === after.updated) return details;

  for (const name of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    if (ALWAYS.has(name) || same(before.fields[name], after.fields[name])) continue;
    details.push(`${name}: ${show(before.fields[name])} → ${show(after.fields[name])}`);
  }
  const commented = (after.comments ?? 0) !== (before.comments ?? 0);
  for (const name of new Set([...Object.keys(before.sections), ...Object.keys(after.sections)])) {
    if (before.sections[name] === after.sections[name] || (name === "Comments" && commented)) continue;
    const label = name || "the text before the first heading";
    if (!(name in before.sections)) details.push(`section added: ${label}`);
    else if (!(name in after.sections)) details.push(`section removed: ${label}`);
    else details.push(`section changed: ${label}`);
  }
  return details;
}

// ---------------------------------------------------------------------------
// Which tasks a change affects

function briefSources(text: string): { files: string[]; id: string | null } {
  const { data, body } = splitFrontMatter(text);
  const files: string[] = [];
  if (Array.isArray(data?.sources)) for (const file of data.sources) if (typeof file === "string") files.push(path.posix.normalize(file));
  const section = body.match(/^## Sources\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? "";
  for (const match of section.matchAll(LOCAL_LINK)) {
    const target = path.posix.normalize(path.posix.join("tasks/x", decodeURI(match[1]!)));
    if (!target.startsWith("..")) files.push(target);
  }
  const id = data?.id === undefined || data?.id === null ? null : String(data.id);
  return { files, id };
}

/**
 * Each task's sources, by item key: what its brief lists (its Sources section and its
 * `sources:`), the item with the task's own id, and one step further from those: their
 * parent, their `links`, and what their bodies link to locally.
 */
function taskSources(root: string, items: Map<string, Scanned>, previous: Record<string, ItemState>): Map<string, Set<string>> {
  const byFile = new Map<string, string>();
  for (const [key, state] of Object.entries(previous)) byFile.set(state.file, key);
  for (const [key, item] of items) byFile.set(item.state.file, key);
  const byId = new Map<string, string[]>();
  const byUrl = new Map<string, string>();
  const index = (key: string, state: ItemState) => {
    const id = String(state.fields.id);
    if (!byId.get(id)?.includes(key)) byId.set(id, [...(byId.get(id) ?? []), key]);
    if (typeof state.fields.url === "string") byUrl.set(state.fields.url, key);
  };
  for (const [key, state] of Object.entries(previous)) index(key, state);
  for (const [key, item] of items) index(key, item.state);

  const result = new Map<string, Set<string>>();
  const tasks = safePath(root, "tasks");
  let ids: string[] = [];
  try {
    ids = readdirSync(tasks, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return result;
  }
  for (const task of ids) {
    let brief: string;
    try {
      brief = readFileSync(path.join(tasks, task, "brief.md"), "utf8");
    } catch {
      continue;
    }
    const { files, id } = briefSources(brief);
    const seeds = new Set<string>();
    for (const file of files) {
      const key = byFile.get(file);
      if (key) seeds.add(key);
    }
    for (const key of byId.get(id ?? task) ?? []) seeds.add(key);

    const sources = new Set(seeds);
    for (const key of seeds) {
      const item = items.get(key);
      const state = item?.state ?? previous[key];
      if (!state) continue;
      const service = String(state.fields.service);
      const parent = state.fields.parent;
      if (parent !== undefined && parent !== null) {
        for (const other of byId.get(String(parent)) ?? []) if (other.startsWith(`${service}:`)) sources.add(other);
      }
      const links = Array.isArray(state.fields.links) ? state.fields.links : [];
      for (const link of links.map(String)) {
        const other = byUrl.get(link) ?? byId.get(link)?.[0];
        if (other) sources.add(other);
      }
      for (const file of item?.links ?? []) {
        const other = byFile.get(file);
        if (other) sources.add(other);
      }
    }
    result.set(task, sources);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recording

function relativeLink(from: string, to: string): string {
  return path.posix.relative(path.posix.dirname(from), to).split(" ").join("%20");
}

function time(): string {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

async function writeReport(root: string, date: string, label: string, changes: Change[], entries: Map<string, Map<string, number>>): Promise<string> {
  const file = path.join(dayDir(root, date), "changes.md");
  const relative = path.posix.join("work-sessions", date, "changes.md");
  const lines = [`## ${time()} · ${label}`, ""];
  for (const change of changes) {
    lines.push(`- [${change.id}](${relativeLink(relative, change.file)}) · ${change.service} · ${show(change.title)}`);
    for (const detail of change.details) lines.push(`  - ${detail}`);
    if (change.tasks.length > 0) {
      const affects = change.tasks.map((task) => `[${task}](${relativeLink(relative, `tasks/${task}/changes.md`)}) (C${entries.get(task)?.get(change.key)})`);
      lines.push(`  - Affects: ${affects.join(", ")}`);
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  if (!existsSync(file)) {
    await writeFile(file, `# Source changes · ${date}\n\nWritten by \`dev sync\`: one section per sync, each item with what changed and the tasks it affects.\n`, { flag: "wx" }).catch(() => {});
  }
  await appendFile(file, `\n${lines.join("\n")}\n`);
  return relative;
}

/** Adds a `new` entry to each affected task's changes.md. Returns each task's entry numbers by item key. */
async function writeTaskEntries(root: string, date: string, changes: Change[]): Promise<Map<string, Map<string, number>>> {
  const byTask = new Map<string, Change[]>();
  for (const change of changes) for (const task of change.tasks) byTask.set(task, [...(byTask.get(task) ?? []), change]);
  const numbers = new Map<string, Map<string, number>>();
  const report = path.posix.join("work-sessions", date, "changes.md");
  for (const [task, list] of byTask) {
    const relative = `tasks/${task}/${CHANGES.file}`;
    const file = safePath(root, relative);
    const current = existsSync(file) ? await readFile(file, "utf8") : logHeader(CHANGES);
    let next = nextNumber(CHANGES, current);
    const added: string[] = [];
    const mine = new Map<string, number>();
    for (const change of list) {
      mine.set(change.key, next);
      added.push(renderEntry(CHANGES, {
        number: next++,
        kind: change.service,
        status: "new",
        fields: [
          ["Item", `[${change.file}](${relativeLink(relative, change.file)})`],
          ["Changed", change.details.join("; ")],
          ["Report", `[${report}](${relativeLink(relative, report)})`],
          ["Recorded", `${date} ${time()}`],
        ],
        text: `${change.id} · ${show(change.title)}`,
      }));
    }
    await atomicWrite(file, `${current.trimEnd()}\n\n${added.join("\n\n")}\n`);
    numbers.set(task, mine);
  }
  return numbers;
}

/**
 * Compares the items on disk with the last baseline, records what changed in the day's
 * change report and in each affected task, and moves the baseline on. The first run only
 * sets the baseline.
 */
export async function recordChanges(root: string, config: ProjectConfig, registry: Registry, label: string): Promise<ChangeResult> {
  const items = scan(root, config, registry);
  const baseline = readBaseline(root);
  const save = () => {
    const next: Baseline = { version: VERSION, synced: new Date().toISOString(), items: Object.fromEntries([...items].map(([key, item]) => [key, item.state])) };
    atomicWriteSync(baselineFile(root), `${JSON.stringify(next, null, 1)}\n`);
  };
  if (!baseline) {
    save();
    return { changes: null, report: null };
  }

  const changes: Change[] = [];
  const describe = (key: string, state: ItemState, details: string[]) =>
    changes.push({ key, service: String(state.fields.service), id: String(state.fields.id), title: String(state.fields.title ?? ""), file: state.file, details, tasks: [] });
  for (const [key, item] of items) {
    const before = baseline.items[key];
    if (!before) describe(key, item.state, [item.state.fields.inScope === false ? "added, as context" : "added"]);
    else {
      const details = compareItem(before, item.state);
      if (details.length > 0) describe(key, item.state, details);
    }
  }
  for (const [key, state] of Object.entries(baseline.items)) {
    if (!items.has(key)) describe(key, state, ["no longer in the workspace"]);
  }

  let report: string | null = null;
  if (changes.length > 0) {
    const sources = taskSources(root, items, baseline.items);
    for (const change of changes) change.tasks = [...sources].filter(([, keys]) => keys.has(change.key)).map(([task]) => task).sort();
    changes.sort((a, b) => a.service.localeCompare(b.service) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const date = today();
    const entries = await writeTaskEntries(root, date, changes);
    report = await writeReport(root, date, label, changes, entries);
  }
  save();
  return { changes, report };
}
