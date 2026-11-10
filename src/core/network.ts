/** Authenticated requests must never follow a provider-supplied URL to another origin. */
export function providerUrl(value: string, base: string): string {
  const url = new URL(value, base);
  const expected = new URL(base);
  if (url.origin !== expected.origin || url.username || url.password || !["https:", "http:"].includes(url.protocol)) {
    throw new Error("Refusing an authenticated request outside the configured service origin.");
  }
  if (url.protocol !== "https:" && !isLocal(url)) {
    throw new Error("Service credentials require HTTPS (except local test servers).");
  }
  return url.href;
}

function isLocal(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

const MAX_REDIRECTS = 5;
/** The only headers a redirect to another origin keeps. Any other may carry a credential. */
const PUBLIC_HEADERS = ["accept", "user-agent"];

/**
 * A fetch with a time limit, which follows redirects itself so credentials never leave the
 * origin they were meant for. A redirect within the origin, like a renamed repository,
 * keeps its headers. One to another origin, like an attachment on a media host, is followed
 * with only the public headers. Only reads are redirected.
 */
export async function boundedFetch(url: string | URL, options: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
  const method = (options.method ?? "GET").toUpperCase();
  let current = new URL(url);
  let headers = new Headers(options.headers);
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, { ...options, headers, redirect: "manual", signal });
    const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get("location") : null;
    if (!location) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    if (method !== "GET" && method !== "HEAD") throw new Error("the server redirected a request that isn't a read");
    const next = new URL(location, current);
    if (next.origin !== current.origin) {
      if (next.protocol !== "https:" && !(next.protocol === "http:" && isLocal(next))) throw new Error("the server redirected to an address that isn't HTTPS");
      const kept = new Headers();
      for (const name of PUBLIC_HEADERS) if (headers.has(name)) kept.set(name, headers.get(name)!);
      headers = kept;
    }
    current = next;
  }
}
