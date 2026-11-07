import { spawnSync } from "node:child_process";
import type { Credentials } from "../types.ts";
import { DevError } from "../../core/output.ts";

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
  const result = spawnSync("gh", ["auth", "status", "--hostname", HOST], { encoding: "utf8" });
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
  const result = spawnSync("gh", ["auth", "token", "--hostname", HOST, "--user", user], { encoding: "utf8" });
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
      response = await fetch(url, {
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
      throw new DevError(`GitHub answered ${response.status} for ${new URL(url).pathname}${message ? `: ${message}` : ""}.`);
    }
    return response;
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.fetch(`${apiBase()}${path}`)).json()) as T;
  }

  /** Follows Link headers until `limit` items, so a big account can't stall a command. */
  async list<T>(path: string, limit = 1000): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = `${apiBase()}${path}${path.includes("?") ? "&" : "?"}per_page=100`;

    while (url && items.length < limit) {
      const response = await this.fetch(url);
      items.push(...((await response.json()) as T[]));
      url = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return items.slice(0, limit);
  }
}
