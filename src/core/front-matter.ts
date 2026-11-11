import { atomicWrite } from "./files.ts";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

/**
 * Every synced item is a Markdown file whose front matter starts with these fields. A
 * plugin may add its own after them. The core builds each folder's index from them.
 */
export interface CommonFields {
  id: string;
  title: string;
  /** The service that wrote it, like "atlassian:jira". */
  service: string;
  url: string;
  /** When it last changed in the service, as an ISO date or date-time. */
  updated: string;
  /** When this file was written. */
  synced: string;
  status?: string;
  parent?: string;
  links?: string[];
}

/**
 * Why an item is in the workspace: its service's scope, the parent of an item in scope,
 * linked from a task or PR, pulled by hand, or formerly in the scope. Items not in the
 * scope are context for the work, not work themselves.
 */
export type Via = "scope" | "parent" | "linked" | "pulled" | "former";

export const REQUIRED_FIELDS = ["id", "title", "service", "url", "updated", "synced"] as const;

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontMatter(text: string): { data: Record<string, unknown> | null; body: string } {
  const match = text.match(FENCE);
  if (!match) return { data: null, body: text };
  try {
    const data: unknown = parse(match[1] ?? "");
    return {
      data: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null,
      body: text.slice(match[0].length),
    };
  } catch {
    return { data: null, body: text };
  }
}

/** The fields that are missing or the wrong type. Empty when the front matter is usable. */
export function missingFields(data: Record<string, unknown> | null): string[] {
  if (!data) return [...REQUIRED_FIELDS];
  return REQUIRED_FIELDS.filter((field) => {
    const value = data[field];
    return !(typeof value === "string" && value.trim()) && !(value instanceof Date);
  });
}

/** A Markdown file with the common fields first, then the plugin's own, then the body. */
export function renderItem(fields: CommonFields & Record<string, unknown>, body: string): string {
  const { id, title, service, url, updated, synced, status, parent, links, ...extra } = fields;
  const ordered: Record<string, unknown> = { id, title, service, url, updated, synced };
  if (status !== undefined) ordered.status = status;
  if (parent !== undefined) ordered.parent = parent;
  if (links !== undefined && links.length > 0) ordered.links = links;
  Object.assign(ordered, extra);

  return `---\n${stringify(ordered).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/**
 * Writes an item, keeping its file exactly as it was when only the sync time would change.
 * Otherwise every sync would rewrite every file, and the diff would bury what moved.
 * Returns whether the file was new, changed, or left alone.
 */
export async function writeItem(file: string, fields: CommonFields & Record<string, unknown>, body: string): Promise<"added" | "updated" | "unchanged"> {
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    const previous = splitFrontMatter(current).data?.synced;
    if (typeof previous === "string" && renderItem({ ...fields, synced: previous }, body) === current) return "unchanged";
    await atomicWrite(file, renderItem(fields, body));
    return "updated";
  }
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, renderItem(fields, body));
  return "added";
}

/** Changes some front matter fields of an item in place, keeping its body. Returns whether anything changed. */
export async function updateFields(file: string, changes: Record<string, unknown>): Promise<boolean> {
  const current = readFileSync(file, "utf8");
  const { data, body } = splitFrontMatter(current);
  if (!data || missingFields(data).length > 0) return false;
  if (Object.entries(changes).every(([key, value]) => data[key] === value)) return false;
  await atomicWrite(file, renderItem({ ...(data as unknown as CommonFields), ...changes }, body));
  return true;
}
