import { setTimeout as sleep } from "node:timers/promises";
import { DevError } from "../../core/output.ts";

/**
 * Notion's API, with an internal integration's secret. The integration only sees pages and
 * databases someone has shared with it, which is Notion's own way of limiting what it reads.
 */

const VERSION = "2022-06-28";

export function apiBase(): string {
  return (process.env.DEV_NOTION_API_URL ?? "https://api.notion.com").replace(/\/$/, "");
}

/** A page or database id, with dashes, from any of the forms Notion uses. */
export function normaliseId(text: string): string | null {
  const hex = text.replace(/-/g, "").match(/[0-9a-f]{32}/i)?.[0];
  if (!hex) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class NotionApi {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/v1${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        throw new DevError(`Couldn't reach Notion: ${(error as Error).message}.`);
      }
      if (response.ok) return (await response.json()) as T;
      if (response.status === 401) throw new DevError("Notion rejected the saved token.", 'Run "dev login notion" again.');
      if (response.status === 404) throw new DevError("Notion can't find that page, or it isn't shared with the integration.", "In Notion, open the page's ... menu > Connections, and add the integration.");
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await sleep(Number(response.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt);
        continue;
      }
      const message = ((await response.json().catch(() => ({}))) as { message?: string }).message;
      throw new DevError(`Notion answered ${response.status}${message ? `: ${message}` : ""}.`);
    }
  }

  /** Every result of a paged list. */
  async all<T>(method: "GET" | "POST", path: string, body: Record<string, unknown> = {}): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | undefined;
    do {
      const page: { results: T[]; has_more: boolean; next_cursor: string | null } =
        method === "GET"
          ? await this.request("GET", `${path}${path.includes("?") ? "&" : "?"}page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`)
          : await this.request("POST", path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      results.push(...page.results);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return results;
  }
}
