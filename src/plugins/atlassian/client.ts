import { boundedFetch, providerUrl } from "../../core/network.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { Credentials } from "../types.ts";
import { DevError, NotFound } from "../../core/output.ts";

/**
 * One Atlassian Cloud site, for Jira and Confluence alike: an API token works across
 * both products on a site. Retries rate limits and server errors with backoff, and says
 * so once, so a long sync doesn't look stuck.
 */

export interface Site {
  /** Like https://example.atlassian.net, with no trailing slash. */
  url: string;
  email: string;
  token: string;
}

export function siteFrom(credentials: Credentials): Site {
  const url = credentials.site?.replace(/\/+$/, "");
  if (!url || !credentials.email || !credentials.token) {
    throw new DevError("The saved Atlassian login is incomplete.", 'Run "dev login atlassian" again.');
  }
  return { url, email: credentials.email, token: credentials.token };
}

const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
let warnedAboutRetry = false;

export class AtlassianClient {
  readonly site: Site;
  private readonly auth: string;

  constructor(site: Site) {
    this.site = site;
    this.auth = `Basic ${Buffer.from(`${site.email}:${site.token}`).toString("base64")}`;
  }

  url(pathOrUrl: string): string {
    return providerUrl(pathOrUrl, this.site.url);
  }

  async request(pathOrUrl: string, accept = "application/json", timeoutMs?: number): Promise<Response> {
    const url = this.url(pathOrUrl);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await boundedFetch(url, { headers: { Authorization: this.auth, Accept: accept } }, timeoutMs);
      } catch (error) {
        throw new DevError(`Couldn't reach ${this.site.url}: ${(error as Error).message}.`, "Check your connection and the site address.");
      }
      if (response.ok) return response;

      if (response.status === 401) throw new DevError(`${this.site.url} rejected the saved login.`, 'Run "dev login atlassian" again with a new API token.');
      if (response.status === 403) throw new DevError(`Your Atlassian account can't see ${new URL(url).pathname}.`, "Ask for access, or change the scope.");
      if (response.status === 404) throw new NotFound(`Not found on ${this.site.url}: ${new URL(url).pathname}.`);

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        const body = await response.text().catch(() => "");
        const message = body.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? body.match(/"errorMessages"\s*:\s*\["([^"]+)"/)?.[1];
        throw new DevError(`${this.site.url} answered ${response.status} for ${new URL(url).pathname}${message ? `: ${message}` : ""}.`);
      }

      if (!warnedAboutRetry) {
        warnedAboutRetry = true;
        console.error(`Atlassian is ${response.status === 429 ? "rate limiting" : "having trouble"}; waiting and retrying.`);
      }
      const retryAfter = Number(response.headers.get("retry-after")) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(MAX_BACKOFF_MS, retryAfter) : Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) + Math.random() * 250);
    }
  }

  async get<T>(pathOrUrl: string): Promise<T> {
    return (await (await this.request(pathOrUrl)).json()) as T;
  }

  async download(pathOrUrl: string): Promise<Buffer> {
    // The time limit covers reading the body too, so a download gets longer than a request.
    const response = await this.request(pathOrUrl, "*/*", DOWNLOAD_TIMEOUT_MS);
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 25 * 1024 * 1024) throw new Error("Attachment exceeds the 25 MiB download limit.");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }

  browseUrl(key: string): string {
    return `${this.site.url}/browse/${key}`;
  }
}

/** Runs at most `concurrency` tasks at once. */
export function limiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (!run) return;
    active++;
    run();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
