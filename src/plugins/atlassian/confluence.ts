import { safePath, atomicWrite } from "../../core/files.ts";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { posix } from "node:path";
import type { Reference, Scope, Service, ServiceContext, SyncReport } from "../types.ts";
import { renderItem, splitFrontMatter, updateFields, type CommonFields, type Via } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { localLookup } from "../../core/links.ts";
import { DevError, OutsideScope, describeError } from "../../core/output.ts";
import { ask, search as searchPrompt, searchRemote } from "../../core/prompt.ts";
import { count, step, tally } from "../../core/progress.ts";
import { mirrorAttachments } from "./attachments.ts";
import { AtlassianClient, limiter, siteFrom } from "./client.ts";
import { convertStorageToMarkdown } from "./html.ts";

/**
 * Confluence: each root page in scope and everything under it, mirrored as one folder per
 * page: confluence/<SPACE>/<Title-id>/<Child-id>/index.md.
 *
 * A tree downloads into a staging folder and replaces the old copy only once every page
 * succeeded, so a failure or a killed sync never loses pages.
 */

const SERVICE = "atlassian:confluence";
const MAX_DEPTH = 10;

interface Page {
  id: string;
  title: string;
  spaceId?: string;
  version?: { number: number; createdAt?: string };
  body?: { storage?: { value: string } };
  _links?: { webui?: string };
}

interface Descendant {
  id: string;
  type: string;
  title: string;
  parentId: string | null;
  depth?: number;
}

function client(context: ServiceContext): AtlassianClient {
  return new AtlassianClient(siteFrom(context.credentials()));
}

function folder(context: ServiceContext): string {
  return context.folder ?? path.join(context.root, "confluence");
}

async function paginate<T>(api: AtlassianClient, start: string): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = start;
  const visited = new Set<string>();
  while (url) {
    if (visited.has(url)) throw new Error("Confluence returned a repeated pagination URL.");
    visited.add(url);
    const page: { results: T[]; _links?: { next?: string } } = await api.get(url);
    results.push(...page.results);
    url = page._links?.next ?? null;
  }
  return results;
}

function getPage(api: AtlassianClient, id: string): Promise<Page> {
  return api.get<Page>(`/wiki/api/v2/pages/${id}?body-format=storage`);
}

/**
 * Every descendant at any depth. The endpoint defaults to depth 2 and allows at most 10,
 * so a node at the limit may have children beyond it, and the walk continues from there.
 */
async function descendants(api: AtlassianClient, rootId: string): Promise<Descendant[]> {
  const seen = new Map<string, Descendant>();
  const queried = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() ?? "";
    if (queried.has(id)) continue;
    queried.add(id);
    for (const entry of await paginate<Descendant>(api, `/wiki/api/v2/pages/${id}/descendants?limit=250&depth=${MAX_DEPTH}`)) {
      if (!seen.has(entry.id)) seen.set(entry.id, entry);
      if (entry.depth === MAX_DEPTH) queue.push(entry.id);
    }
  }
  return [...seen.values()];
}

/** A folder name from a title: one underscore per run of other characters, then -<id>. */
export function pageDirName(title: string, id: string): string {
  const name = title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120).replace(/_+$/, "") || "untitled";
  return `${name}-${id}`;
}

/** The page's file, kept exactly as it was if only the sync time would change. */
function stableContent(previous: string | null, fields: CommonFields & Record<string, unknown>, body: string): { content: string; state: "added" | "updated" | "unchanged" } {
  if (previous !== null && existsSync(previous)) {
    const current = readFileSync(previous, "utf8");
    const synced = splitFrontMatter(current).data?.synced;
    if (typeof synced === "string" && renderItem({ ...fields, synced }, body) === current) return { content: current, state: "unchanged" };
    return { content: renderItem(fields, body), state: "updated" };
  }
  return { content: renderItem(fields, body), state: "added" };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Puts back a copy moved aside by a sync that was killed mid-swap, and clears its leftovers. */
async function recover(staging: string, name: string, target: string): Promise<void> {
  if (!existsSync(staging)) return;
  for (const entry of await readdir(staging)) {
    if (!entry.startsWith(`${name}.`)) continue;
    const pid = Number(entry.slice(name.length + 1));
    if (!Number.isInteger(pid) || isRunning(pid)) continue;
    const old = path.join(staging, entry, "old");
    if (existsSync(old) && !existsSync(target)) {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(old, target);
    }
    await rm(path.join(staging, entry), { recursive: true, force: true });
  }
}

interface TreeResult {
  title: string;
  dir: string;
  report: SyncReport;
  warnings: string[];
}

/**
 * Syncs one root page, and with `withChildren` everything under it. `inScope` marks
 * whether it came from the scope, so a sync knows what it may remove later.
 */
async function syncTree(context: ServiceContext, api: AtlassianClient, rootId: string, options: { withChildren: boolean; via: Via; attachments: boolean }): Promise<TreeResult> {
  const base = folder(context);
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const warnings: string[] = [];

  const [root, below] = await Promise.all([getPage(api, rootId), options.withChildren ? descendants(api, rootId) : Promise.resolve([])]);
  const space = root.spaceId ? await api.get<{ key: string }>(`/wiki/api/v2/spaces/${root.spaceId}`) : { key: "unknown-space" };
  const rootName = pageDirName(root.title, root.id);
  const target = safePath(base, `${space.key}/${rootName}`);
  const previousRoot = (await topFolders(context)).find((entry) => entry.data?.id === root.id)?.dir ?? target;
  if (!path.resolve(target).startsWith(path.resolve(base) + path.sep)) throw new Error("Refusing to write outside the confluence folder.");

  const stagingRoot = path.join(base, ".staging");
  await recover(stagingRoot, rootName, target);
  const staging = path.join(stagingRoot, `${rootName}.${process.pid}`);
  const staged = path.join(staging, "new");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
  if (existsSync(previousRoot)) {
    // Copy the entire tree, including user notes and departed pages, before changing owned files.
    for (const relative of await readdir(previousRoot, { recursive: true, encoding: "utf8" })) safePath(previousRoot, relative);
    await cp(previousRoot, staged, { recursive: true });
  }

  // Folders follow the parent chain, not the API's depth field, so order doesn't matter.
  const children = new Map<string, Descendant[]>();
  for (const entry of below) children.set(entry.parentId ?? "", [...(children.get(entry.parentId ?? "") ?? []), entry]);
  const dirs = new Map<string, string>([[root.id, ""]]);
  const walk = (parent: string, dir: string): void => {
    for (const entry of children.get(parent) ?? []) {
      const child = dir ? posix.join(dir, pageDirName(entry.title, entry.id)) : pageDirName(entry.title, entry.id);
      dirs.set(entry.id, child);
      walk(entry.id, child);
    }
  };
  walk(root.id, "");

  const pages = [{ id: root.id, title: root.title }, ...below.filter((d) => d.type === "page")];
  const byTitle = new Map<string, string>();
  for (const page of pages) {
    if (byTitle.has(page.title)) warnings.push(`Two pages are called "${page.title}"; links to that title may go to the wrong one.`);
    else byTitle.set(page.title, page.id);
  }

  // Migrate renamed descendants by stable page id before parallel page writes.
  for (const [id, relative] of dirs) {
    if (!relative) continue;
    const desired = safePath(staged, relative);
    if (existsSync(path.join(desired, "index.md")) && splitFrontMatter(await readFile(path.join(desired, "index.md"), "utf8")).data?.id === id) continue;
    for (const name of await readdir(staged, { recursive: true, encoding: "utf8" })) {
      if (path.basename(name) !== "index.md") continue;
      const source = path.dirname(path.join(staged, name));
      if (splitFrontMatter(await readFile(path.join(staged, name), "utf8")).data?.id !== id || source === desired) continue;
      if (existsSync(desired)) throw new Error("Conflicting Confluence destination; preserve both folders and resolve manually.");
      await mkdir(path.dirname(desired), { recursive: true });
      await rename(source, desired);
      break;
    }
  }
  const limitPages = limiter(4);
  let failed = 0;

  await Promise.all(
    pages.map((entry) =>
      limitPages(async () => {
        const dir = dirs.get(entry.id);
        if (dir === undefined) return;
        try {
          const pageDir = dir ? safePath(staged, dir) : staged;
          await mkdir(pageDir, { recursive: true });
          const page = entry.id === root.id ? root : await getPage(api, entry.id);

          const files = options.attachments ? await syncAttachments(api, entry.id, pageDir, (message) => warnings.push(`[${entry.title}] ${message}`)) : new Map<string, string>();

          const { markdown, warnings: conversion } = convertStorageToMarkdown(page.body?.storage?.value ?? "", {
            resolvePageLink(title) {
              const id = byTitle.get(title);
              const to = id ? dirs.get(id) : undefined;
              return to === undefined ? null : posix.join(posix.relative(dir, to) || ".", "index.md");
            },
            resolveAttachment: (filename) => files.get(filename) ?? null,
            jiraBrowseUrl: (key) => api.browseUrl(key),
          });
          for (const warning of conversion) warnings.push(`[${page.title}] ${warning}`);
          // Links are relative to where the page ends up, not to the staging folder.
          const body = await context.localize(markdown, path.join(target, dir, "index.md"));

          const { content, state } = stableContent(
            path.join(staged, dir, "index.md"),
            {
              id: page.id,
              title: page.title,
              service: SERVICE,
              url: page._links?.webui ? `${api.site.url}/wiki${page._links.webui.replace(/^\/wiki/, "")}` : `${api.site.url}/wiki/pages/${page.id}`,
              updated: page.version?.createdAt ?? "",
              synced: new Date().toISOString(),
              space: space.key,
              version: page.version?.number ?? 0,
              root: root.id,
              inScope: options.via === "scope",
              via: options.via,
            },
            body,
          );
          await atomicWrite(path.join(pageDir, "index.md"), content);
          if (state !== "unchanged") report[state]++;
        } catch (error) {
          failed++;
          report.failed.push({ id: `${entry.title} (${entry.id})`, reason: describeError(error) });
        }
      }),
    ),
  );

  try {
    if (failed === 0) {
      if (options.withChildren) {
        const live = new Set(pages.map((page) => page.id));
        for (const name of await readdir(staged, { recursive: true, encoding: "utf8" })) {
          if (path.basename(name) !== "index.md") continue;
          const file = path.join(staged, name);
          const data = splitFrontMatter(await readFile(file, "utf8")).data;
          if (data?.service === SERVICE && !live.has(String(data.id)) && await updateFields(file, { inScope: false, via: "former" })) report.removed++;
        }
      }
      await mkdir(path.dirname(target), { recursive: true });
      const old = path.join(staging, "old");
      const had = existsSync(target);
      if (had) await rename(target, old);
      try {
        await rename(staged, target);
      } catch (error) {
        if (had) await rename(old, target);
        throw error;
      }
      if (previousRoot !== target && existsSync(previousRoot)) await rm(previousRoot, { recursive: true });
    } else {
      warnings.push(`${root.title}: ${failed} page${failed === 1 ? "" : "s"} failed, so the previous copy was kept. Run the sync again.`);
    }
  } finally {
    if (!(existsSync(path.join(staging, "old")) && !existsSync(target))) {
      await rm(staging, { recursive: true, force: true });
      await rmdir(stagingRoot).catch(() => {});
    }
  }

  return { title: root.title, dir: path.relative(context.root, target), report, warnings };
}

function roots(scope: Scope): string[] {
  return Array.isArray(scope.roots) ? scope.roots.map(String) : [];
}

function spaces(scope: Scope): string[] {
  return Array.isArray(scope.spaces) ? scope.spaces.map(String) : [];
}

/** The root pages to sync: the ones listed, plus every top-level page of each whole space. */
async function allRoots(api: AtlassianClient, scope: Scope): Promise<string[]> {
  const ids = [...roots(scope)];
  for (const key of spaces(scope)) {
    const found = await api.get<{ results: Array<{ id: string }> }>(`/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}`);
    const space = found.results[0];
    if (!space) throw new DevError(`There's no Confluence space ${key}, or you can't see it.`, 'Run "dev confluence scope".');
    for (const page of await paginate<{ id: string }>(api, `/wiki/api/v2/spaces/${space.id}/pages?depth=root&limit=250`)) {
      if (!ids.includes(page.id)) ids.push(page.id);
    }
  }
  return ids;
}

const INDEX: NonNullable<Service["index"]> = { folder: "confluence", title: "Confluence pages" };

function index(context: ServiceContext): void {
  if (context.deferIndex) return;
  if (existsSync(folder(context))) buildIndex(folder(context), INDEX.title, INDEX.include);
}

/** Top-level page folders: confluence/<SPACE>/<Title-id>, with their front matter. */
async function topFolders(context: ServiceContext): Promise<Array<{ dir: string; data: Record<string, unknown> | null }>> {
  const base = folder(context);
  if (!existsSync(base)) return [];
  const found: Array<{ dir: string; data: Record<string, unknown> | null }> = [];
  for (const space of await readdir(base, { withFileTypes: true })) {
    if (!space.isDirectory() || space.name.startsWith(".")) continue;
    for (const page of await readdir(path.join(base, space.name), { withFileTypes: true })) {
      if (!page.isDirectory()) continue;
      const dir = path.join(base, space.name, page.name);
      const file = path.join(dir, "index.md");
      found.push({ dir, data: existsSync(file) ? splitFrontMatter(await readFile(file, "utf8")).data : null });
    }
  }
  return found;
}

async function sync(context: ServiceContext): Promise<SyncReport> {
  if (roots(context.scope).length === 0 && spaces(context.scope).length === 0) {
    throw new DevError("Confluence has no pages in scope yet.", 'Run "dev confluence scope".');
  }
  const api = client(context);
  const ids = await allRoots(api, context.scope);
  const total: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };

  const tick = tally(context.progress, ids.length, "page tree");
  for (const id of ids) {
    try {
      const result = await syncTree(context, api, id, { withChildren: true, via: "scope", attachments: context.scope.attachments !== false });
      total.added += result.report.added;
      total.updated += result.report.updated;
      total.removed += result.report.removed;
      total.failed.push(...result.report.failed);
      for (const warning of result.warnings.filter((w) => !/Unsupported macro|User mention/.test(w))) context.out.warn(`  ${warning}`);
    } catch (error) {
      total.failed.push({ id, reason: describeError(error) });
    }
    tick();
  }

  // Trees whose root left the scope stay, marked as outside it. Files are cheap, and history matters.
  for (const { dir, data } of await topFolders(context)) {
    if (data?.inScope === true && typeof data.root === "string" && !ids.includes(data.root) && data.root === data.id) {
      for (const file of (await readdir(dir, { recursive: true, encoding: "utf8" })).filter((f) => path.basename(f) === "index.md")) {
        await updateFields(path.join(dir, file), { inScope: false, via: "former" });
      }
      total.removed++;
    }
  }

  index(context);
  return total;
}

/** Every mirrored page's file, by page id, from the folder names alone. */
const pageFile = localLookup(async (context) => {
  const base = folder(context);
  const files = new Map<string, string>();
  if (!existsSync(base)) return files;
  for (const relative of await readdir(base, { recursive: true, encoding: "utf8" })) {
    const id = path.basename(relative) === "index.md" && !relative.startsWith(".") ? path.basename(path.dirname(relative)).match(/-(\d+)$/)?.[1] : undefined;
    if (id) files.set(id, path.join(base, relative));
  }
  return files;
});

/** Where a page is already mirrored, if anywhere. */
async function localPage(context: ServiceContext, id: string): Promise<string | null> {
  const base = folder(context);
  if (!existsSync(base)) return null;
  const match = (await readdir(base, { recursive: true, encoding: "utf8" })).find((f) => path.basename(path.dirname(f)).endsWith(`-${id}`) && path.basename(f) === "index.md");
  return match ? path.join(base, match) : null;
}

/**
 * Whether a page is inside the scope: a listed page, under one, or in a whole space in it.
 * Only the page's metadata is read to tell, never its content.
 */
/** Whether a page is inside the scope. Pass what's known about the page, and a cache of space keys, to save requests. */
async function withinScope(context: ServiceContext, api: AtlassianClient, id: string, known?: { spaceId?: string }, spaceKeys = new Map<string, Promise<string>>()): Promise<boolean> {
  if (context.settings.fetch === "anywhere") return true;
  const listed = roots(context.scope);
  if (listed.includes(id)) return true;
  const page = known ?? (await api.get<{ spaceId?: string }>(`/wiki/api/v2/pages/${id}`));
  if (spaces(context.scope).length > 0 && page.spaceId) {
    const spaceId = page.spaceId;
    if (!spaceKeys.has(spaceId)) spaceKeys.set(spaceId, api.get<{ key: string }>(`/wiki/api/v2/spaces/${spaceId}`).then((space) => space.key));
    if (spaces(context.scope).includes(await spaceKeys.get(spaceId)!)) return true;
  }
  if (listed.length === 0) return false;
  const ancestors = await paginate<{ id: string }>(api, `/wiki/api/v2/pages/${id}/ancestors?limit=250`).catch(() => [] as Array<{ id: string }>);
  return ancestors.some((ancestor) => listed.includes(ancestor.id));
}

/** Every page already in the workspace: its file, and its front matter. */
async function localPages(context: ServiceContext): Promise<Array<{ file: string; data: Record<string, unknown> }>> {
  const base = folder(context);
  if (!existsSync(base)) return [];
  const pages: Array<{ file: string; data: Record<string, unknown> }> = [];
  for (const relative of (await readdir(base, { recursive: true, encoding: "utf8" })).filter((f) => path.basename(f) === "index.md" && f !== "index.md" && !f.startsWith("."))) {
    const { data } = splitFrontMatter(await readFile(path.join(base, relative), "utf8"));
    if (data && typeof data.id === "string") pages.push({ file: path.join(base, relative), data });
  }
  return pages;
}

/**
 * Updates the pages already in the workspace, one by one, without pulling the rest of the
 * scope. Only pages whose version changed are fetched again.
 */
async function refresh(context: ServiceContext): Promise<SyncReport> {
  const api = client(context);
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const pages = await localPages(context);
  const byTitle = new Map(pages.map((p) => [String(p.data.title), path.dirname(p.file)]));
  const limit = limiter(4);
  const spaceKeys = new Map<string, Promise<string>>();

  const tick = tally(context.progress, pages.length, "page");
  await Promise.all(
    pages.map((local) =>
      limit(async () => {
        const id = String(local.data.id);
        try {
          // One small request tells if the page changed; only changed pages are checked against
          // the scope and downloaded again.
          const meta = await api.get<{ spaceId?: string; version?: { number: number } }>(`/wiki/api/v2/pages/${id}`);
          if (meta.version?.number === local.data.version) return;
          if (!await withinScope(context, api, id, meta, spaceKeys)) return;
          const page = await getPage(api, id);
          const dir = path.dirname(local.file);
          const files = context.scope.attachments !== false ? await syncAttachments(api, id, dir, (message) => (report.warnings ??= []).push(`[${String(local.data.title)}] ${message}`)) : new Map<string, string>();
          const { markdown } = convertStorageToMarkdown(page.body?.storage?.value ?? "", {
            resolvePageLink(title) {
              const to = byTitle.get(title);
              return to ? posix.join(path.relative(dir, to).split(path.sep).join("/") || ".", "index.md") : null;
            },
            resolveAttachment: (filename) => files.get(filename) ?? null,
            jiraBrowseUrl: (key) => api.browseUrl(key),
          });
          const { content, state } = stableContent(local.file, { ...(local.data as unknown as CommonFields), title: page.title, updated: page.version?.createdAt ?? String(local.data.updated), synced: new Date().toISOString(), version: page.version?.number ?? 0 }, await context.localize(markdown, local.file));
          if (state !== "unchanged") {
            await atomicWrite(local.file, content);
            report.updated++;
          }
        } catch (error) {
          report.failed.push({ id: `${String(local.data.title)} (${id})`, reason: describeError(error) });
        }
      }).finally(tick),
    ),
  );
  index(context);
  return report;
}

/**
 * A short link, /wiki/x/<code>: the page id, little-endian, in a URL-safe base64 that
 * leaves out the padding.
 */
export function shortLinkId(code: string): string | null {
  if (!/^[A-Za-z0-9_-]{2,16}$/.test(code)) return null;
  const base64 = code.replace(/-/g, "/").replace(/_/g, "+");
  const bytes = Buffer.from(base64 + "A".repeat((4 - (base64.length % 4)) % 4), "base64");
  let id = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) id = (id << 8n) | BigInt(bytes[i] ?? 0);
  return id > 0n ? id.toString() : null;
}

const SHORT_LINK = /https?:\/\/[\w.-]+(?::\d+)?\/wiki\/x\/([A-Za-z0-9_-]+)/g;

const PAGE_LINK = /https?:\/\/[\w.-]+(?::\d+)?\/wiki\/[^\s)<>"']*?(?:\/pages\/(\d+)|pageId=(\d+))[^\s)<>"']*/g;

function pageIdFrom(word: string): string | null {
  const short = word.match(/\/wiki\/x\/([A-Za-z0-9_-]+)/)?.[1];
  if (short) return shortLinkId(short);
  return word.match(/\/pages\/(\d+)|pageId=(\d+)/)?.slice(1).find(Boolean) ?? (/^\d+$/.test(word) ? word : null);
}

/** Pages in a space whose title matches, newest first, from Confluence's own search. */
async function findPages(api: AtlassianClient, space: string, term: string): Promise<Array<{ value: string; name: string; description?: string }>> {
  const words = term.replace(/["\\]/g, " ").trim();
  const cql = `space = "${space}" AND type = page${words ? ` AND title ~ "${words}*"` : ""} ORDER BY lastmodified DESC`;
  const result = await api.get<{ results: Array<{ id: string; title: string; _expandable?: unknown }> }>(
    `/wiki/rest/api/content/search?limit=30&cql=${encodeURIComponent(cql)}`,
  );
  return result.results.map((page) => ({ value: page.id, name: page.title }));
}

const PASTE = "__paste";
const DONE = "__done";

const WHOLE = "__whole";

async function chooseScope(context: ServiceContext): Promise<Scope> {
  const api = client(context);
  const all = await step(
    context.out,
    "Loading Confluence spaces",
    () => paginate<{ id: string; key: string; name: string }>(api, "/wiki/api/v2/spaces?limit=250"),
    (found) => `Found ${count(found.length, "Confluence space")}`,
  );
  if (all.length === 0) throw new DevError("Your Atlassian account can't see any Confluence spaces.");

  const ids: string[] = [];
  const whole: string[] = [];
  for (;;) {
    const chosen = new Set([...whole]);
    const key = await searchPrompt(
      ids.length + whole.length === 0
        ? `Which space? Type any part of its name or key (${all.length} spaces).`
        : `Another space? (so far: ${[...whole, ...(ids.length > 0 ? [`${ids.length} page${ids.length === 1 ? "" : "s"}`] : [])].join(", ")})`,
      [
        ...(ids.length + whole.length > 0 ? [{ value: DONE, name: "Done: that's all the spaces" }] : []),
        ...all.filter((s) => !chosen.has(s.key)).map((s) => ({ value: s.key, name: s.name, description: s.key })),
      ],
      "edit dev.yaml",
    );
    if (key === DONE) break;

    // The whole space, or chosen pages in it, each found by searching its title.
    let added = 0;
    for (;;) {
      const picked = await searchRemote(
        added === 0 ? `In ${key}: the whole space, or which page? Each page comes with everything under it.` : `In ${key}: added ${added}. Another page?`,
        async (term) => [
          ...(added === 0 ? [{ value: WHOLE, name: `The whole ${key} space` }] : [{ value: DONE, name: `Done with ${key}` }]),
          ...(await findPages(api, key, term)).filter((p) => !ids.includes(p.value)),
          { value: PASTE, name: "Paste page links or ids instead" },
        ],
        "edit dev.yaml",
      );
      if (picked === DONE) break;
      if (picked === WHOLE) {
        whole.push(key);
        break;
      }
      if (picked === PASTE) {
        for (const word of (await ask("Page links or ids, separated by spaces:", "edit dev.yaml")).split(/\s+/)) {
          const id = pageIdFrom(word);
          if (id && !ids.includes(id)) {
            ids.push(id);
            added++;
          }
        }
        continue;
      }
      ids.push(picked);
      added++;
    }
  }

  if (ids.length === 0 && whole.length === 0) throw new DevError("Nothing was chosen.");
  return { ...(whole.length > 0 ? { spaces: whole } : {}), ...(ids.length > 0 ? { roots: ids } : {}), attachments: true };
}

export const confluence: Service = {
  id: "confluence",
  title: "Confluence",
  index: INDEX,
  description: "Specs and docs, one folder per page",
  role: "connected",

  scope: {
    describe(scope) {
      const parts = [];
      if (spaces(scope).length > 0) parts.push(`whole space${spaces(scope).length === 1 ? "" : "s"} ${spaces(scope).join(", ")}`);
      if (roots(scope).length > 0) parts.push(`${roots(scope).length} page tree${roots(scope).length === 1 ? "" : "s"}`);
      return parts.join(" and ") || "nothing yet";
    },
    choose: chooseScope,
    add(scope, items) {
      const ids = roots(scope);
      const added: string[] = [];
      const problems = [];
      for (const item of items) {
        const id = pageIdFrom(item);
        if (!id) problems.push({ message: `"${item}" isn't a Confluence page link or id.` });
        else if (!ids.includes(id) && !added.includes(id)) added.push(id);
      }
      return { scope: { ...scope, roots: [...ids, ...added] }, added, problems };
    },
    remove(scope, items) {
      const ids = roots(scope);
      const keys = spaces(scope);
      const removed: string[] = [];
      const problems = [];
      for (const item of items) {
        const id = pageIdFrom(item);
        if (id && ids.includes(id)) removed.push(id);
        else if (keys.includes(item)) removed.push(item);
        else problems.push({ message: `"${item}" isn't in the scope.` });
      }
      const next: Scope = { ...scope, roots: ids.filter((id) => !removed.includes(id)), spaces: keys.filter((key) => !removed.includes(key)) };
      if ((next.roots as string[]).length === 0) delete next.roots;
      if ((next.spaces as string[]).length === 0) delete next.spaces;
      return { scope: next, removed, problems };
    },
    validate(scope) {
      const ids = scope.roots;
      const keys = scope.spaces;
      if (ids === undefined && keys === undefined) return [{ message: 'needs "roots", a list of page ids, or "spaces", a list of space keys.' }];
      if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => /^\d+$/.test(String(id))))) {
        return [{ message: '"roots" should be a list of page ids, like [12345, 67890].' }];
      }
      if (scope.attachments !== undefined && typeof scope.attachments !== "boolean") return [{ message: '"attachments" should be true or false.' }];
      if (keys !== undefined && (!Array.isArray(keys) || !keys.every((key) => typeof key === "string" && /^[A-Za-z0-9~_-]+$/.test(key)))) {
        return [{ message: '"spaces" should be a list of space keys, like [DOCS, ENG].' }];
      }
      if (roots(scope).length === 0 && spaces(scope).length === 0) return [{ message: "has no pages or spaces in it." }];
      return [];
    },
  },

  sync,
  refresh,

  links: {
    find(text) {
      const found: Reference[] = [];
      for (const match of text.matchAll(PAGE_LINK)) {
        const id = match[1] ?? match[2];
        if (id && !found.some((r) => r.id === id)) found.push({ service: SERVICE, id, url: match[0].replace(/&amp;/g, "&").replace(/[.,;]+$/, "") });
      }
      for (const match of text.matchAll(SHORT_LINK)) {
        const id = shortLinkId(match[1] ?? "");
        if (id && !found.some((r) => r.id === id)) found.push({ service: SERVICE, id, url: match[0] });
      }
      return found;
    },
    async fetch(context, reference) {
      const existing = await localPage(context, reference.id);
      if (existing) return existing;
      const api = client(context);
      if (!(await withinScope(context, api, reference.id))) throw new OutsideScope(`Confluence page ${reference.url ?? reference.id}`);
      const result = await syncTree(context, api, reference.id, { withChildren: false, via: "linked", attachments: true });
      index(context);
      return path.join(context.root, result.dir, "index.md");
    },
    local: (context, reference) => pageFile(context, reference.id),
  },

  contribute: {
    async dayEnd(context, date) {
      const base = folder(context);
      if (!existsSync(base)) return [];
      const lines: string[] = [];
      for (const file of (await readdir(base, { recursive: true, encoding: "utf8" })).filter((f) => path.basename(f) === "index.md" && f !== "index.md")) {
        const { data } = splitFrontMatter(await readFile(path.join(base, file), "utf8"));
        if (String(data?.updated ?? "").startsWith(date)) lines.push(`- ${String(data?.title)} changed in Confluence`);
      }
      return lines;
    },
  },

  commands: [
    {
      name: "pull",
      description: "Pull one page and everything under it, within the configured fetch boundary",
      mark: "read",
      writes: true,
      arguments: ["<page>"],
      help: "The page is a link or an id, within the configured fetch boundary. It's kept up to date while it stays inside the scope.",
      async run(context, args) {
        const word = args[0] ?? "";
        const id = pageIdFrom(word);
        if (!id) throw new DevError(`"${word}" isn't a Confluence page link or id.`);
        const api = client(context);
        if (!(await withinScope(context, api, id))) throw new OutsideScope(`Confluence page ${word}`);
        const result = await syncTree(context, api, id, { withChildren: true, via: "pulled", attachments: true });
        index(context);
        for (const warning of result.warnings) context.out.warn(`  ${warning}`);
        context.out.info(`${result.dir}: ${result.report.added} new, ${result.report.updated} updated${result.report.failed.length > 0 ? `, ${result.report.failed.length} failed` : ""}.`);
        if (result.report.failed.length > 0) process.exitCode = 1;
      },
    },
  ],

  agentFiles: {
    rules: ["Read Confluence pages from confluence/, starting at its index.md. Never edit or comment on a Confluence page unless the person asks you to in this conversation."],
    docs: [
      {
        file: "confluence.md",
        content: `# Confluence in this workspace

Pages are mirrored one folder per page, following the page tree:
\`confluence/<SPACE>/<Title-id>/<Child-id>/index.md\`. Links between pages point to the local
files, and attachments sit in each page's \`attachments/\` folder (set \`attachments: false\`
in the scope to leave them out).

Links to tickets, issues and other pages that are in the workspace point to the local
files; the original address is kept as the link's title. A link that is still a web address
has no local copy. If it's outside the scope, the page ends with an "Outside the scope"
section giving the exact command that adds it.

## Finding pages

Read \`confluence/index.md\`, then open only the pages you need. Never read the whole folder.

The index's **Why** column says why each page is here: **scope** pages belong to the spaces
and page trees this workspace follows; **linked** pages were fetched because a ticket, PR or
brief points to them; **pulled** ones were pulled by hand; **former** ones have left the
scope.

## Pages that aren't here

The workspace only fetches pages within its scope. A brief or a sync lists links outside it
as "not fetched", with their URLs. Don't fetch them another way: tell the person, who can
add one with \`dev confluence scope add <link>\`.

## Commands

| Command | Does |
| --- | --- |
| \`dev confluence pull <link or id>\` | Pull a page and everything under it, within the scope |
| \`dev confluence scope\` | Show what's in scope |

Changing the scope, and anything that changes Confluence, is the person's call.`,
      },
    ],
  },
};

/** A page's attachments, by filename, as files relative to its folder. */
async function syncAttachments(api: AtlassianClient, id: string, dir: string, warn: (message: string) => void): Promise<Map<string, string>> {
  const attachments = await paginate<{ id?: string; title: string; downloadLink: string; version?: { number: number } }>(api, `/wiki/api/v2/pages/${id}/attachments?limit=250`);
  const remote = attachments.map((attachment) => ({
    key: attachment.id ?? attachment.title,
    title: attachment.title,
    link: attachment.downloadLink.startsWith("http") || attachment.downloadLink.startsWith("/wiki") ? attachment.downloadLink : `/wiki${attachment.downloadLink}`,
    version: attachment.version?.number,
  }));
  const files = await mirrorAttachments(api, dir, remote, warn, true);
  return new Map(remote.flatMap((attachment) => (files.has(attachment.key) ? [[attachment.title, files.get(attachment.key)!] as const] : [])));
}
