import { boundedFetch, providerUrl } from "../../core/network.ts";
import { spawnSync } from "node:child_process";
import type { Credentials } from "../types.ts";
import { DevError, NotFound } from "../../core/output.ts";

/**
 * GitHub's REST API, with a token from one of two places:
 *
 * - "gh": the token of a named gh account, asked from gh each time and never stored.
 *   Works with several gh accounts, whichever one is active.
 * - "token": a token the person pasted, stored in the credentials file.
 *
 * DEV_GITHUB_TOKEN overrides both, for scripts. DEV_GITHUB_API_URL points at another
 * server, for tests and later for GitHub Enterprise.
 */

export const HOST = "github.com";

export function apiBase(): string {
  return (process.env.DEV_GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
}

export function webBase(): string {
  return (process.env.DEV_GITHUB_WEB_URL ?? `https://${HOST}`).replace(/\/$/, "");
}

/** The gh accounts logged in on this machine, by reading gh's own status. */
export function ghAccounts(): string[] {
  const result = spawnSync("gh", ["auth", "status", "--hostname", HOST], { encoding: "utf8", timeout: 15_000 });
  if (result.error) {
    throw new DevError("The GitHub CLI (gh) isn't installed.", 'Install it, run "gh auth login", or log in with a token instead.');
  }
  const text = `${result.stdout}\n${result.stderr}`;
  const accounts: string[] = [];
  for (const match of text.matchAll(/✓ Logged in to \S+ account (\S+)/g)) {
    if (match[1]) accounts.push(match[1]);
  }
  return accounts;
}

/** A gh account's token, straight from gh. Only ever held in memory. */
export function ghToken(user: string): string {
  const result = spawnSync("gh", ["auth", "token", "--hostname", HOST, "--user", user], { encoding: "utf8", timeout: 15_000 });
  const token = result.stdout?.trim();
  if (result.error || result.status !== 0 || !token) {
    throw new DevError(`gh has no working login for the account ${user}.`, `Run "gh auth login" for ${user}, then try again.`);
  }
  return token;
}

export function tokenFor(credentials: Credentials): string {
  if (credentials.token) return credentials.token;
  if (credentials.method === "gh" && credentials.user) return ghToken(credentials.user);
  throw new DevError("The saved GitHub login is incomplete.", 'Run "dev login github" again.');
}

const MAX_ATTACHMENT = 25 * 1024 * 1024;

/**
 * An attachment on an issue, a PR or a comment, downloaded without the login: a public one
 * redirects to storage, and a private image's address in the rendered HTML is signed for a
 * few minutes. The token never leaves the API, so only GitHub's own hosts are fetched.
 */
export async function downloadAttachment(link: string): Promise<Buffer> {
  const url = new URL(link);
  const web = new URL(webBase());
  const github = url.origin === web.origin || (url.protocol === "https:" && (url.hostname === "githubusercontent.com" || url.hostname.endsWith(".githubusercontent.com")));
  if (!github || url.username || url.password) throw new Error("it isn't on GitHub");
  const response = await boundedFetch(url, { headers: { "User-Agent": "dev-cli" } }, 5 * 60_000);
  if (!response.ok) throw new Error(`GitHub answered ${response.status}${response.status === 404 ? ": the upload is gone, or it's a private repository's file, which needs a browser login" : ""}`);
  if (/^text\/html/i.test(response.headers.get("content-type") ?? "")) throw new Error("GitHub answered with a sign-in page");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT) throw new Error("it's over the 25 MiB download limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export class GitHubApi {
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  static from(credentials: Credentials): GitHubApi {
    return new GitHubApi(tokenFor(credentials));
  }

  private async fetch(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await boundedFetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "dev-cli",
        },
      });
    } catch (error) {
      throw new DevError(`Couldn't reach GitHub: ${(error as Error).message}.`, "Check your connection, then try again.");
    }

    if (response.status === 401) {
      throw new DevError("GitHub rejected the saved login.", 'Run "dev login github" again.');
    }
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      const when = reset ? ` until ${new Date(reset).toLocaleTimeString()}` : "";
      throw new DevError(`GitHub's rate limit is used up${when}.`, "Wait, then try again.");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const message = (() => {
        try {
          return (JSON.parse(body) as { message?: string }).message;
        } catch {
          return undefined;
        }
      })();
      const text = `GitHub answered ${response.status} for ${new URL(url).pathname}${message ? `: ${message}` : ""}.`;
      throw response.status === 404 || response.status === 410 ? new NotFound(text) : new DevError(text);
    }
    return response;
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.fetch(providerUrl(`${apiBase()}${path}`, apiBase()))).json()) as T;
  }

  /** A GraphQL query. GitHub Projects is only reachable this way. */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await boundedFetch(providerUrl(`${apiBase()}/graphql`, apiBase()), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", "User-Agent": "dev-cli" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new DevError(`Couldn't reach GitHub: ${(error as Error).message}.`, "Check your connection, then try again.");
    }
    if (response.status === 401) throw new DevError("GitHub rejected the saved login.", 'Run "dev login github" again.');
    if (!response.ok) throw new DevError(`GitHub GraphQL answered ${response.status}.`);
    const body = (await response.json()) as { data?: T; errors?: Array<{ message: string; type?: string }> };
    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join("; ");
      if (/scope|read:project|INSUFFICIENT_SCOPES/i.test(message) || body.errors.some((e) => e.type === "INSUFFICIENT_SCOPES")) {
        throw new DevError("The GitHub login can't read projects.", 'Give it the read:project scope: "gh auth refresh -s read:project", or a token with that scope.');
      }
      if (!body.data) throw new DevError(`GitHub answered: ${message}`);
    }
    if (!body.data) throw new DevError("GitHub GraphQL returned no data.");
    return body.data as T;
  }

  /** Follows Link headers until `limit` items, so a big account can't stall a command. Longer lists are cut off there. */
  async list<T>(path: string, limit = 1000): Promise<T[]> {
    return (await this.listUpTo<T>(path, limit)).items;
  }

  /** Like list, and says whether the list was cut off, for callers that must not mistake a partial list for the whole. */
  async listUpTo<T>(path: string, limit: number): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let url: string | null = `${apiBase()}${path}${path.includes("?") ? "&" : "?"}per_page=100`;

    const visited = new Set<string>();
    while (url && items.length < limit) {
      if (visited.has(url)) throw new DevError("GitHub returned a repeated pagination URL.");
      visited.add(url);
      const response = await this.fetch(providerUrl(url, apiBase()));
      items.push(...((await response.json()) as T[]));
      url = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return { items: items.slice(0, limit), truncated: url !== null || items.length > limit };
  }
}
