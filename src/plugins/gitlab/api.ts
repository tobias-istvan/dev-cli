import { boundedFetch, providerUrl } from "../../core/network.ts";
import type { Credentials } from "../types.ts";
import { DevError, NotFound } from "../../core/output.ts";

/**
 * GitLab's REST API (v4), on gitlab.com or a self-hosted server, with a personal access
 * token. The server comes from the login, so one workspace can use a company's own GitLab.
 */

export interface Server {
  /** Like https://gitlab.com, with no trailing slash. */
  host: string;
  token: string;
}

export function serverFrom(credentials: Credentials): Server {
  const host = (credentials.host ?? "https://gitlab.com").replace(/\/+$/, "");
  if (!credentials.token) throw new DevError("The saved GitLab login is incomplete.", 'Run "dev login gitlab" again.');
  return { host, token: credentials.token };
}

/** A project's path as the API wants it in a URL: group%2Fproject. */
export function projectId(path: string): string {
  return encodeURIComponent(path);
}

export class GitLabApi {
  readonly server: Server;

  constructor(server: Server) {
    this.server = server;
  }

  static from(credentials: Credentials): GitLabApi {
    return new GitLabApi(serverFrom(credentials));
  }

  private async fetch(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await boundedFetch(providerUrl(url, this.server.host), { headers: { "PRIVATE-TOKEN": this.server.token, Accept: "application/json" } });
    } catch (error) {
      throw new DevError(`Couldn't reach ${this.server.host}: ${(error as Error).message}.`, "Check your connection and the server address.");
    }
    if (response.status === 401) throw new DevError(`${this.server.host} rejected the saved token.`, 'Run "dev login gitlab" again.');
    if (response.status === 403) throw new DevError(`Your GitLab account can't see ${new URL(url).pathname}.`);
    if (response.status === 404) throw new NotFound(`Not found on ${this.server.host}: ${decodeURIComponent(new URL(url).pathname)}.`);
    if (response.status === 429) throw new DevError("GitLab's rate limit was reached.", "Wait a minute, then try again.");
    if (!response.ok) throw new DevError(`${this.server.host} answered ${response.status} for ${new URL(url).pathname}.`);
    return response;
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.fetch(`${this.server.host}/api/v4${path}`)).json()) as T;
  }

  /** Follows GitLab's paging until `limit` items. Longer lists are cut off there. */
  async list<T>(path: string, limit = 1000): Promise<T[]> {
    return (await this.listUpTo<T>(path, limit)).items;
  }

  /** Like list, and says whether the list was cut off, for callers that must not mistake a partial list for the whole. */
  async listUpTo<T>(path: string, limit: number): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let page = 1;
    while (items.length < limit) {
      const response = await this.fetch(`${this.server.host}/api/v4${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      items.push(...((await response.json()) as T[]));
      const next = response.headers.get("x-next-page");
      if (!next) return { items: items.slice(0, limit), truncated: items.length > limit };
      if (!Number.isInteger(Number(next)) || Number(next) <= page) throw new DevError("GitLab returned a non-advancing pagination cursor.");
      page = Number(next);
    }
    return { items: items.slice(0, limit), truncated: true };
  }
}
