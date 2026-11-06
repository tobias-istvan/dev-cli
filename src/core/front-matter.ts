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
