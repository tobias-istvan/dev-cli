import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, Reference, Scope, Service, ServiceContext, SyncReport } from "../types.ts";
import { splitFrontMatter, updateFields, writeItem, type CommonFields, type Via } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { describeError, DevError, OutsideScope } from "../../core/output.ts";
import { chooseMany, secret } from "../../core/prompt.ts";
import { NotionApi, normaliseId } from "./api.ts";
import { blocksToMarkdown, richText, type Block, type RichText } from "./markdown.ts";

/**
 * Notion: pages and databases, mirrored like Confluence, one folder per page:
 * notion/<Title-id>/<Child-id>/index.md. A database's rows are pages under it. The scope is
 * a list of root pages and databases; the integration also has to be connected to them in
 * Notion, which is Notion's own limit on what it can read.
 *
 * Pages whose last edit hasn't changed aren't fetched again.
 */

const SERVICE = "notion:notion";

interface Page {
  id: string;
  url: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  parent: { type: string; page_id?: string; database_id?: string; block_id?: string };
  properties: Record<string, { type: string; title?: RichText[]; rich_text?: RichText[]; select?: { name: string } | null; status?: { name: string } | null; multi_select?: Array<{ name: string }>; date?: { start: string } | null; people?: Array<{ name?: string }>; number?: number | null; checkbox?: boolean; url?: string | null }>;
}

interface Database {
  id: string;
  url: string;
  last_edited_time: string;
  title: RichText[];
}

function api(context: ServiceContext): NotionApi {
  const token = context.credentials().token;
  if (!token) throw new DevError("The saved Notion login is incomplete.", 'Run "dev login notion" again.');
  return new NotionApi(token);
}

function folder(context: ServiceContext): string {
  return context.folder ?? path.join(context.root, "notion");
}

function dirName(title: string, id: string): string {
  return `${title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100) || "Untitled"}-${id.replace(/-/g, "").slice(0, 12)}`;
}

function titleOf(page: Page): string {
  const property = Object.values(page.properties).find((p) => p.type === "title");
  return richText(property?.title) || "Untitled";
}

/** A row's other properties, as plain values, for its front matter. */
function properties(page: Page): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, p] of Object.entries(page.properties)) {
    const value =
      p.type === "rich_text" ? richText(p.rich_text)
      : p.type === "select" ? p.select?.name
      : p.type === "status" ? p.status?.name
      : p.type === "multi_select" ? p.multi_select?.map((s) => s.name).join(", ")
      : p.type === "date" ? p.date?.start
      : p.type === "people" ? p.people?.map((u) => u.name ?? "").filter(Boolean).join(", ")
      : p.type === "number" ? (p.number === null || p.number === undefined ? "" : String(p.number))
      : p.type === "checkbox" ? (p.checkbox ? "yes" : "no")
      : p.type === "url" ? (p.url ?? "")
      : undefined;
    if (value) values[name] = value;
  }
  return values;
}

function roots(scope: Scope): string[] {
  return [...(Array.isArray(scope.pages) ? scope.pages : []), ...(Array.isArray(scope.databases) ? scope.databases : [])].map((id) => normaliseId(String(id)) ?? String(id));
}

/** Every page already here, by id, with its file and front matter. */
async function localPages(context: ServiceContext): Promise<Map<string, { file: string; data: Record<string, unknown> }>> {
  const pages = new Map<string, { file: string; data: Record<string, unknown> }>();
  if (!existsSync(folder(context))) return pages;
  for (const relative of (await readdir(folder(context), { recursive: true, encoding: "utf8" })).filter((f) => path.basename(f) === "index.md" && f !== "index.md")) {
    const file = path.join(folder(context), relative);
    const { data } = splitFrontMatter(await readFile(file, "utf8"));
    if (data && typeof data.id === "string") pages.set(data.id, { file, data });
  }
  return pages;
}

interface Walk {
  api: NotionApi;
  local: Map<string, { file: string; data: Record<string, unknown> }>;
  report: SyncReport;
  via: Via;
  root: string;
  seen: Set<string>;
}

/** Syncs a page and the pages under it, into `dir`. */
async function syncPage(context: ServiceContext, walk: Walk, id: string, dir: string, page?: Page): Promise<void> {
  if (walk.seen.has(id)) return;
  walk.seen.add(id);
  const current = page ?? (await walk.api.request<Page>("GET", `/pages/${id}`));
  if (current.archived || current.in_trash) return;
  const title = titleOf(current);
  const here = path.join(dir, dirName(title, id));
  const file = path.join(here, "index.md");
  const known = walk.local.get(id);

  // Unchanged since the last sync: keep the file, and only walk to the children it recorded.
  if (known && known.data.updated === current.last_edited_time && path.resolve(known.file) === path.resolve(file)) {
    for (const child of Array.isArray(known.data.children) ? known.data.children.map(String) : []) {
      await syncChild(context, walk, child, here);
    }
    return;
  }

  const found: Array<{ id: string; kind: "page" | "database" }> = [];
  const markdown = await blocksToMarkdown(walk.api, await walk.api.all<Block>("GET", `/blocks/${id}/children`), {
    childLink: (childId, childTitle) => `${dirName(childTitle, childId)}/index.md`,
    onChild: (childId, _title, kind) => found.push({ id: childId, kind }),
  });
  const result = await writeItem(
    file,
    {
      id,
      title,
      service: SERVICE,
      url: current.url,
      updated: current.last_edited_time,
      synced: new Date().toISOString(),
      ...(current.parent.type === "database_id" ? { properties: properties(current) } : {}),
      children: found.map((c) => c.id),
      root: walk.root,
      inScope: walk.via === "scope",
      via: walk.via,
    },
    markdown,
  );
  if (result !== "unchanged") walk.report[result]++;
  for (const child of found) await syncChild(context, walk, child.id, here, child.kind);
}

async function syncChild(context: ServiceContext, walk: Walk, id: string, dir: string, kind?: "page" | "database"): Promise<void> {
  try {
    if (kind === "database" || (!kind && walk.local.get(id)?.data.database === true)) await syncDatabase(context, walk, id, dir);
    else await syncPage(context, walk, id, dir);
  } catch (error) {
    walk.report.failed.push({ id, reason: describeError(error) });
  }
}

/** A database: an index page listing its rows, and each row as a page under it. */
async function syncDatabase(context: ServiceContext, walk: Walk, id: string, dir: string): Promise<void> {
  if (walk.seen.has(id)) return;
  walk.seen.add(id);
  const database = await walk.api.request<Database>("GET", `/databases/${id}`);
  const title = richText(database.title) || "Untitled database";
  const here = path.join(dir, dirName(title, id));
  const rows = await walk.api.all<Page>("POST", `/databases/${id}/query`);
  const live = rows.filter((row) => !row.archived && !row.in_trash);

  const result = await writeItem(
    path.join(here, "index.md"),
    {
      id,
      title,
      service: SERVICE,
      url: database.url,
      updated: database.last_edited_time,
      synced: new Date().toISOString(),
      database: true,
      children: live.map((row) => row.id),
      root: walk.root,
      inScope: walk.via === "scope",
      via: walk.via,
    },
    [`A Notion database with ${live.length} row${live.length === 1 ? "" : "s"}.`, "", ...live.map((row) => `- [${titleOf(row)}](${dirName(titleOf(row), row.id)}/index.md)`)].join("\n"),
  );
  if (result !== "unchanged") walk.report[result]++;
  for (const row of live) {
    try {
      await syncPage(context, walk, row.id, here, row);
    } catch (error) {
      walk.report.failed.push({ id: row.id, reason: describeError(error) });
    }
  }
}

function index(context: ServiceContext): void {
  if (existsSync(folder(context))) buildIndex(folder(context), "Notion pages");
}

async function sync(context: ServiceContext): Promise<SyncReport> {
  const scope = context.scope;
  const pages = (Array.isArray(scope.pages) ? scope.pages : []).map((id) => normaliseId(String(id)) ?? "");
  const databases = (Array.isArray(scope.databases) ? scope.databases : []).map((id) => normaliseId(String(id)) ?? "");
  if (pages.length + databases.length === 0) throw new DevError("Notion has no pages in scope yet.", 'Run "dev notion scope".');

  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const local = await localPages(context);
  const notion = api(context);
  const seen = new Set<string>();
  for (const [id, kind] of [...pages.map((id) => [id, "page"] as const), ...databases.map((id) => [id, "database"] as const)]) {
    await syncChild(context, { api: notion, local, report, via: "scope", root: id, seen }, id, folder(context), kind);
  }

  // Pages in scope before and not reached now stay, marked: moved, deleted, or the root left.
  for (const [id, page] of local) {
    if (page.data.inScope === true && !seen.has(id) && (await updateFields(page.file, { inScope: false, via: "former" }))) report.removed++;
  }
  index(context);
  return report;
}

/** Only pages already here are refreshed, for "referenced" syncing. */
async function refresh(context: ServiceContext): Promise<SyncReport> {
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const local = await localPages(context);
  const notion = api(context);
  for (const [id, page] of local) {
    if (page.data.database === true) continue;
    try {
      const current = await notion.request<Page>("GET", `/pages/${id}`);
      if (current.last_edited_time === page.data.updated) continue;
      const markdown = await blocksToMarkdown(notion, await notion.all<Block>("GET", `/blocks/${id}/children`), {
        childLink: (childId, title) => {
          const child = local.get(childId);
          return child ? path.relative(path.dirname(page.file), child.file).split(path.sep).join("/") : `${dirName(title, childId)}/index.md`;
        },
      });
      const { data } = splitFrontMatter(await readFile(page.file, "utf8"));
      if ((await writeItem(page.file, { ...(data as unknown as CommonFields), title: titleOf(current), updated: current.last_edited_time, synced: new Date().toISOString() }, markdown)) !== "unchanged") report.updated++;
    } catch (error) {
      report.failed.push({ id, reason: describeError(error) });
    }
  }
  index(context);
  return report;
}

/** Whether a page is under a root in scope, by walking up its parents. Only metadata is read. */
async function withinScope(context: ServiceContext, notion: NotionApi, id: string): Promise<boolean> {
  if (context.settings.fetch === "anywhere") return true;
  const listed = roots(context.scope);
  let current: string | undefined = id;
  for (let depth = 0; current && depth < 25; depth++) {
    if (listed.includes(current)) return true;
    // The id may be a page, a database or a block; each kind has its own endpoint.
    const id: string = current;
    const item = await notion
      .request<{ parent: Page["parent"] }>("GET", `/pages/${id}`)
      .catch(() => notion.request<{ parent: Page["parent"] }>("GET", `/databases/${id}`))
      .catch(() => notion.request<{ parent: Page["parent"] }>("GET", `/blocks/${id}`));
    current = item.parent.page_id ?? item.parent.database_id ?? item.parent.block_id;
  }
  return false;
}

const LINK = /https?:\/\/(?:www\.)?(?:notion\.so|[\w-]+\.notion\.site)\/[^\s)<>"'\]]*/g;

export const notionService: Service = {
  id: "notion",
  title: "Notion",
  description: "Pages and databases, one folder per page",
  role: "connected",

  scope: {
    describe(scope) {
      const pages = Array.isArray(scope.pages) ? scope.pages.length : 0;
      const databases = Array.isArray(scope.databases) ? scope.databases.length : 0;
      return [pages > 0 ? `${pages} page tree${pages === 1 ? "" : "s"}` : "", databases > 0 ? `${databases} database${databases === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ") || "nothing yet";
    },
    async choose(context) {
      const notion = api(context);
      const found = await notion.all<{ object: string; id: string; title?: RichText[]; properties?: Page["properties"] }>("POST", "/search", {});
      const options = found
        .filter((r) => r.object === "database" || r.object === "page")
        .map((r) => ({ value: `${r.object}:${r.id}`, name: `${r.object === "database" ? "Database" : "Page"}: ${r.object === "database" ? richText(r.title) : titleOf(r as unknown as Page)}` }));
      if (options.length === 0) throw new DevError("The Notion integration can't see any pages.", "In Notion, open a page's ... menu > Connections, and add the integration.");
      const picked = await chooseMany("Which pages and databases? Each comes with everything under it.", options, "edit dev.yaml");
      return {
        pages: picked.filter((v) => v.startsWith("page:")).map((v) => v.slice(5)),
        databases: picked.filter((v) => v.startsWith("database:")).map((v) => v.slice(9)),
      };
    },
    validate(scope) {
      const ids = [...(Array.isArray(scope.pages) ? scope.pages : []), ...(Array.isArray(scope.databases) ? scope.databases : [])];
      if (ids.length === 0) return [{ message: 'needs "pages" or "databases": lists of Notion ids or links.' }];
      if (!ids.every((id) => normaliseId(String(id)))) return [{ message: "has something that isn't a Notion id or link." }];
      return [];
    },
    add(scope, items) {
      const list = Array.isArray(scope.pages) ? scope.pages.map(String) : [];
      const added: string[] = [];
      const problems = [];
      for (const item of items) {
        const id = normaliseId(item);
        if (!id) problems.push({ message: `"${item}" isn't a Notion page link or id.` });
        else if (!list.includes(id) && !added.includes(id)) added.push(id);
      }
      return { scope: { ...scope, pages: [...list, ...added] }, added, problems };
    },
  },

  sync,
  refresh,

  links: {
    find(text) {
      const found = new Map<string, Reference>();
      for (const match of text.matchAll(LINK)) {
        const url = match[0].replace(/[.,;]+$/, "");
        const id = normaliseId(new URL(url).searchParams.get("p") ?? url.split("?")[0] ?? "");
        if (id && !found.has(id)) found.set(id, { service: SERVICE, id, url });
      }
      return [...found.values()];
    },
    async fetch(context, reference) {
      const local = await localPages(context);
      const known = local.get(reference.id);
      if (known) return known.file;
      const notion = api(context);
      if (!(await withinScope(context, notion, reference.id))) throw new OutsideScope(`Notion page ${reference.url ?? reference.id}`);
      const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
      const page = await notion.request<Page>("GET", `/pages/${reference.id}`);
      await syncPage(context, { api: notion, local, report, via: "linked", root: reference.id, seen: new Set() }, reference.id, folder(context), page);
      index(context);
      return path.join(folder(context), dirName(titleOf(page), reference.id), "index.md");
    },
  },

  agentFiles: {
    rules: ["Read Notion pages from notion/, starting at its index.md. Never edit a Notion page unless the person asks you to in this conversation."],
  },
};

const notion: Plugin = {
  name: "notion",
  title: "Notion",
  description: "Notion pages and databases",
  login: {
    methods: [{ kind: "token", title: "Internal integration secret" }],
    async login(context) {
      context.out.info("Create an integration at https://www.notion.so/profile/integrations with read content access, then connect it to the pages dev should read.");
      const token = (await secret("Integration secret (hidden as you type):", "a terminal")).trim();
      if (!token) throw new DevError("No secret was entered.");
      const me = await new NotionApi(token).request<{ name?: string; bot?: { workspace_name?: string } }>("GET", "/users/me");
      return { account: me.bot?.workspace_name ? `${me.name ?? "integration"} in ${me.bot.workspace_name}` : (me.name ?? "integration"), credentials: { token } };
    },
    async check(_context, credentials) {
      try {
        const me = await new NotionApi(credentials.token ?? "").request<{ name?: string }>("GET", "/users/me");
        return { ok: true, account: me.name ?? "integration" };
      } catch (error) {
        return { ok: false, problem: { message: (error as Error).message, fix: 'Run "dev login notion" again.' } };
      }
    },
  },
  secrets: (credentials) => (credentials.token ? [credentials.token] : []),
  services: [notionService],
};

export default notion;
