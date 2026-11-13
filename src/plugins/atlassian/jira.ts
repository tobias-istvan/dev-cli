import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Reference, Scope, Service, ServiceContext, SyncReport } from "../types.ts";
import { splitFrontMatter, updateFields, writeItem, type Via } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { describeOutside } from "../../core/links.ts";
import { DevError, NotFound, OutsideScope, describeError } from "../../core/output.ts";
import { ask, choose, search as searchPrompt } from "../../core/prompt.ts";
import { count, step } from "../../core/progress.ts";
import { mirrorAttachments } from "./attachments.ts";
import { AtlassianClient, limiter, siteFrom } from "./client.ts";
import { htmlToMarkdown } from "./html.ts";

/**
 * Jira: the tickets in scope, each in its own folder as jira/<KEY>/ticket.md, so research notes
 * or images can sit beside it and are never touched by a sync. The scope is a JQL
 * search. Attachments are kept in the ticket's attachments/ folder, unless the scope says
 * `attachments: false`. Tickets fetched on demand, like a parent or one named in a PR, are kept too,
 * marked as outside the scope, so a sync never removes them.
 */

const SERVICE = "atlassian:jira";
const KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
const LIST_FIELDS = ["summary", "status", "updated"];

interface Issue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string; accountId?: string } | null;
    reporter?: { displayName?: string } | null;
    created?: string;
    updated?: string;
    duedate?: string | null;
    labels?: string[];
    parent?: { key: string; fields?: { summary?: string; issuetype?: { name?: string } } };
    subtasks?: Array<{ key: string; fields?: { summary?: string; status?: { name?: string } } }>;
    issuelinks?: Array<{
      type: { inward?: string; outward?: string };
      inwardIssue?: { key: string; fields?: { summary?: string } };
      outwardIssue?: { key: string; fields?: { summary?: string } };
    }>;
    attachment?: Array<{ id: string; filename: string; size?: number; content?: string }>;
    comment?: { comments?: Array<{ id: string; author?: { displayName?: string }; created?: string }> };
    [field: string]: unknown;
  };
  renderedFields?: Record<string, unknown>;
}

function client(context: ServiceContext): AtlassianClient {
  return new AtlassianClient(siteFrom(context.credentials()));
}

function folder(context: ServiceContext): string {
  return context.folder ?? path.join(context.root, "jira");
}

const TICKET = "ticket.md";
/** The download limit: a bigger attachment is listed in the ticket, not fetched. */
const MAX_ATTACHMENT = 25 * 1024 * 1024;

function file(context: ServiceContext, key: string): string {
  return path.join(folder(context), key, TICKET);
}

/** Moves a ticket from the earlier flat layout, jira/<KEY>.md, into its folder. */
async function migrate(context: ServiceContext, key: string): Promise<void> {
  const flat = path.join(folder(context), `${key}.md`);
  if (existsSync(flat) && !existsSync(file(context, key))) {
    await mkdir(path.dirname(file(context, key)), { recursive: true });
    await rename(flat, file(context, key));
  }
}

async function search(api: AtlassianClient, jql: string, fields: string[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  let token: string | undefined;
  do {
    const url = new URL(`${api.site.url}/rest/api/3/search/jql`);
    url.searchParams.set("jql", jql);
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("fields", fields.join(","));
    if (token) url.searchParams.set("nextPageToken", token);
    const page = await api.get<{ issues?: Issue[]; nextPageToken?: string }>(url.toString());
    issues.push(...(page.issues ?? []));
    token = page.nextPageToken;
  } while (token);
  return issues;
}

/** Custom fields differ per site, so they're found by name. And who's running dev. */
async function lookups(api: AtlassianClient): Promise<Lookups> {
  const [fields, me] = await Promise.all([
    api.get<Array<{ id: string; name: string }>>("/rest/api/3/field"),
    api.get<{ accountId?: string }>("/rest/api/3/myself").catch(() => ({ accountId: undefined })),
  ]);
  const find = (pattern: RegExp) => fields.find((f) => pattern.test(f.name))?.id ?? null;
  return { acceptance: find(/^acceptance criteria$/i), points: find(/^story point(s| estimate)$/i), me: me.accountId ?? null };
}

function branchType(issueType: string): string {
  if (/bug|defect/i.test(issueType)) return "fix";
  if (/task|chore|spike/i.test(issueType)) return "chore";
  return "feature";
}

/** Renders one issue. Related issues link to their local file when it's there, else to Jira. */
interface Lookups {
  acceptance: string | null;
  points: string | null;
  /** The account running dev, to mark tickets assigned to them. */
  me: string | null;
}

async function render(context: ServiceContext, api: AtlassianClient, issue: Issue, ids: Lookups, via: Via): Promise<"added" | "updated" | "unchanged"> {
  const f = issue.fields;
  const rendered = issue.renderedFields ?? {};
  const target = file(context, issue.key);

  // Attachments sit next to the ticket. One too big to download is listed, not fetched.
  const attached = f.attachment ?? [];
  const wanted = context.scope.attachments !== false ? attached.filter((a) => (a.size ?? 0) <= MAX_ATTACHMENT) : [];
  let failed = 0;
  const files = await mirrorAttachments(
    api,
    path.dirname(target),
    wanted.map((a) => ({ key: a.id, title: a.filename, link: a.content ?? `/rest/api/3/attachment/content/${a.id}`, version: 1 })),
    (message) => {
      failed++;
      context.out.warn(`  ${issue.key}: ${message}`);
    },
    false,
  );
  // Jira's HTML points at its own attachment and thumbnail addresses, and at site paths.
  const html = (value: unknown) =>
    typeof value !== "string"
      ? ""
      : value
          .replace(/\b(src|href)="([^"]*\/(?:attachment\/(?:content|thumbnail)|secure\/(?:attachment|thumbnail))\/(\d+)[^"]*)"/g, (whole, attribute: string, _address: string, id: string) =>
            files.has(id) ? `${attribute}="${encodeURI(files.get(id)!)}"` : whole,
          )
          .replace(/\b(src|href)="\/(?!\/)/g, `$1="${api.site.url}/`);
  const description = htmlToMarkdown(html(rendered.description)) || "_No description._";
  const acceptance = ids.acceptance ? htmlToMarkdown(html(rendered[ids.acceptance])) : "";
  const points = ids.points && typeof f[ids.points] === "number" ? (f[ids.points] as number) : null;

  // Written as Jira links: the ones to tickets in the workspace are made local below.
  const link = (key: string) => `[${key}](${api.browseUrl(key)})`;
  const relations = [
    ...(f.parent ? [`- Parent (${f.parent.fields?.issuetype?.name ?? "issue"}): ${link(f.parent.key)} ${f.parent.fields?.summary ?? ""}`] : []),
    ...(f.subtasks ?? []).map((t) => `- Sub-task: ${link(t.key)} [${t.fields?.status?.name ?? "?"}] ${t.fields?.summary ?? ""}`),
    ...(f.issuelinks ?? []).map((l) => {
      const target = l.outwardIssue ?? l.inwardIssue;
      return `- ${(l.outwardIssue ? l.type.outward : l.type.inward) ?? "relates to"} ${link(target?.key ?? "")} ${target?.fields?.summary ?? ""}`;
    }),
  ];

  const comments = f.comment?.comments ?? [];
  const renderedComments = new Map(((rendered.comment as { comments?: Array<{ id: string; body?: unknown }> } | undefined)?.comments ?? []).map((c) => [c.id, c.body]));
  const commentText = comments
    .map((c) => `### ${c.author?.displayName ?? "Unknown"} · ${(c.created ?? "").slice(0, 16).replace("T", " ")}\n\n${htmlToMarkdown(html(renderedComments.get(c.id))) || "_(empty)_"}`)
    .join("\n\n");

  const body = [
    `# ${issue.key}: ${f.summary ?? ""}`,
    "",
    [`**Status:** ${f.status?.name ?? "?"}`, `**Type:** ${f.issuetype?.name ?? "?"}`, ...(f.duedate ? [`**Due:** ${f.duedate}`] : []), ...(points !== null ? [`**Points:** ${points}`] : [])].join(" · "),
    "",
    "## Description",
    "",
    description,
    "",
    "## Acceptance criteria",
    "",
    acceptance || "_This field is empty. Criteria are often written in the description instead._",
    "",
    "## Relations",
    "",
    relations.length > 0 ? relations.join("\n") : "_None._",
    "",
    "## Attachments",
    "",
    attached.length > 0
      ? attached
          .map((a) => {
            const size = a.size ? `${Math.round(a.size / 1024)} KB` : "";
            const local = files.get(a.id);
            return local ? `- [${a.filename}](${encodeURI(local)})${size ? ` (${size})` : ""}` : `- ${a.filename} (${[size, "not downloaded"].filter(Boolean).join(", ")})`;
          })
          .join("\n")
      : "_None._",
    "",
    `## Comments (${comments.length})`,
    "",
    commentText || "_No comments._",
  ].join("\n");

  return writeItem(
    target,
    {
      id: issue.key,
      title: f.summary ?? "",
      service: SERVICE,
      url: api.browseUrl(issue.key),
      updated: f.updated ?? "",
      synced: new Date().toISOString(),
      status: f.status?.name ?? "",
      ...(f.parent ? { parent: f.parent.key } : {}),
      type: f.issuetype?.name ?? "",
      statusCategory: f.status?.statusCategory?.key ?? "",
      priority: f.priority?.name ?? "",
      assignee: f.assignee?.displayName ?? "",
      viewer: ids.me,
      mine: Boolean(ids.me && f.assignee?.accountId === ids.me),
      due: f.duedate ?? "",
      points,
      labels: f.labels ?? [],
      ...(context.scope.attachments !== false ? { attachments: files.size, ...(failed > 0 ? { attachmentsFailed: failed } : {}) } : {}),
      inScope: via === "scope",
      via,
    },
    await context.localize(body, target),
  );
}

async function fetchIssue(api: AtlassianClient, key: string): Promise<Issue> {
  return api.get<Issue>(`/rest/api/3/issue/${encodeURIComponent(key)}?expand=renderedFields`);
}

async function localItems(context: ServiceContext): Promise<Array<{ key: string; data: Record<string, unknown> }>> {
  if (!existsSync(folder(context))) return [];
  const items: Array<{ key: string; data: Record<string, unknown> }> = [];
  for (const entry of await readdir(folder(context), { withFileTypes: true })) {
    // Tickets from the earlier flat layout move into their folders first.
    if (entry.isFile() && /^[A-Z][A-Z0-9]{1,9}-\d+\.md$/.test(entry.name)) await migrate(context, entry.name.slice(0, -3));
  }
  for (const entry of await readdir(folder(context), { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(file(context, entry.name))) continue;
    const { data } = splitFrontMatter(await readFile(file(context, entry.name), "utf8"));
    if (data) items.push({ key: entry.name, data });
  }
  return items;
}

const INDEX: NonNullable<Service["index"]> = { folder: "jira", title: "Jira tickets", include: (f) => path.posix.basename(f) === TICKET };

function index(context: ServiceContext): void {
  if (context.deferIndex) return;
  if (existsSync(folder(context))) buildIndex(folder(context), INDEX.title, INDEX.include);
}

async function sync(context: ServiceContext): Promise<SyncReport> {
  const jql = String(context.scope.jql ?? "");
  if (!jql) throw new DevError("Jira has no scope yet.", 'Run "dev jira scope".');
  const api = client(context);
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };

  const [found, ids, local] = await Promise.all([search(api, jql, LIST_FIELDS), lookups(api), localItems(context)]);
  const known = new Map(local.map((item) => [item.key, item.data]));
  const inScope = new Set(found.map((issue) => issue.key));
  boundaries.set(context, boundaryOf(context, inScope));
  const limit = limiter(4);

  await Promise.all(
    found.map((summary) =>
      limit(async () => {
        const existing = known.get(summary.key);
        // Unchanged in Jira and already marked in scope: nothing to fetch.
        // A ticket written before attachments were kept, or with one that failed, is done again.
        const attachmentsDone = context.scope.attachments === false || (typeof existing?.attachments === "number" && existing.attachmentsFailed === undefined);
        if (existing && existing.updated === summary.fields.updated && existing.inScope === true && existing.viewer === ids.me && attachmentsDone) return;
        try {
          const result = await render(context, api, await fetchIssue(api, summary.key), ids, "scope");
          if (result === "added") report.added++;
          else if (result === "updated") report.updated++;
        } catch (error) {
          report.failed.push({ id: summary.key, reason: describeError(error) });
        }
      }),
    ),
  );

  // Tickets that left the scope stay, marked as outside it. Files are cheap, and history matters.
  // Open ones are looked up again, so they show as done or moved. Done ones rarely change,
  // and ones Jira no longer has are marked gone, so neither is asked for on every sync.
  await Promise.all(
    local
      .filter((item) => !inScope.has(item.key) && item.data.gone !== true)
      .map((item) =>
        limit(async () => {
          const former = item.data.inScope === true ? { inScope: false, via: "former" } : {};
          try {
            if (item.data.statusCategory === "done" || !(await projectAllowed(context, item.key))) {
              // Outside the boundary, a ticket that left the scope is marked so; parents, links and pulls keep their copy, unrefreshed.
              if (item.data.inScope === true && (await updateFields(file(context, item.key), former))) report.removed++;
              return;
            }
            const result = await render(context, api, await fetchIssue(api, item.key), ids, item.data.inScope === true ? "former" : (String(item.data.via ?? "linked") as Via));
            if (result !== "unchanged") report.updated++;
          } catch (error) {
            // Deleted, moved or hidden from this login: the copy stays, and the sync isn't failed by it.
            if (!(error instanceof NotFound)) report.failed.push({ id: item.key, reason: describeError(error) });
            else if ((await updateFields(file(context, item.key), { ...former, gone: true })) && item.data.inScope === true) report.removed++;
          }
        }),
      ),
  );

  // Specs often live on the parent, not the ticket you're assigned, so open tickets' parents
  // are kept too, within the scope.
  const parents = new Set<string>();
  for (const item of await localItems(context)) {
    if (item.data.inScope === true && item.data.statusCategory !== "done" && typeof item.data.parent === "string") parents.add(item.data.parent);
  }
  for (const key of parents) {
    if (existsSync(file(context, key))) continue;
    if (!(await projectAllowed(context, key))) continue;
    try {
      await render(context, api, await fetchIssue(api, key), ids, "parent");
      report.added++;
    } catch (error) {
      if (!(error instanceof OutsideScope)) report.failed.push({ id: key, reason: `parent: ${(error as Error).message}` });
    }
  }

  index(context);
  return report;
}

function keysIn(text: string, scope: Scope): string[] {
  const projects = scopeProjects(scope);
  const keys = new Set<string>();
  for (const match of text.matchAll(KEY)) {
    // Without known projects, any KEY-123 counts; with them, lookalikes like UTF-8 don't.
    if (projects.length === 0 || projects.includes(match[1] ?? "") || linkedProjects(scope).includes(match[1] ?? "")) keys.add(match[0]);
  }
  return [...keys];
}

/** The scope's projects, when it names any. Only then can "outside the scope" be told for a key. */
function scopeProjects(scope: Scope): string[] {
  return Array.isArray(scope.projects) ? scope.projects.map(String) : typeof scope.project === "string" ? [scope.project] : [];
}

/** Projects whose tickets may be fetched when something links to them, beyond the scope's own. */
function linkedProjects(scope: Scope): string[] {
  return Array.isArray(scope.linkedProjects) ? scope.linkedProjects.map(String) : [];
}

/** A project key, from the key itself, a ticket key, or a ticket's link. */
function projectFrom(word: string): string | null {
  return word.match(/\/browse\/([A-Z][A-Z0-9]{1,9})-\d+/)?.[1] ?? word.match(/^([A-Z][A-Z0-9]{1,9})(?:-\d+)?$/)?.[1] ?? null;
}

/** The more specific reason wins: an item in scope stays "scope", a parent stays "parent". */
const RANK: Record<Via, number> = { scope: 4, parent: 3, pulled: 2, linked: 1, former: 0 };

async function fetchOne(context: ServiceContext, reference: Reference, via: Via = "linked"): Promise<string> {
  const cached = context.fetched?.get(reference.id);
  if (cached) return cached;
  await migrate(context, reference.id);
  if (!(await projectAllowed(context, reference.id))) {
    const projects = await boundary(context);
    throw new OutsideScope(`Jira ticket ${reference.id}`, projects !== null && projects.length === 0 ? 'The scope names no projects and no synced ticket shows which it covers yet. Run "dev sync jira" first, add "projects" to the Jira scope, or set "fetch: anywhere" in dev.yaml.' : undefined);
  }
  const api = client(context);
  const target = file(context, reference.id);
  let reason = via;
  if (existsSync(target)) {
    const data = splitFrontMatter(await readFile(target, "utf8")).data;
    const previous = (typeof data?.via === "string" ? data.via : data?.inScope === true ? "scope" : null) as Via | null;
    if (previous && RANK[previous] > RANK[via]) reason = previous;
  }
  await render(context, api, await fetchIssue(api, reference.id), await lookups(api), reason);
  index(context);
  context.fetched?.set(reference.id, target);
  return target;
}

async function chooseScope(context: ServiceContext): Promise<Scope> {
  const api = client(context);
  const projects = await step(
    context.out,
    "Loading Jira projects",
    async (report) => {
      const found: Array<{ key: string; name: string }> = [];
      for (let start = 0; ; ) {
        const page = await api.get<{ values: Array<{ key: string; name: string }>; isLast?: boolean }>(`/rest/api/3/project/search?maxResults=100&startAt=${start}`);
        found.push(...page.values);
        if (page.isLast !== false || page.values.length === 0) break;
        start += page.values.length;
        report(`${found.length} so far`);
      }
      return found;
    },
    (found) => `Found ${count(found.length, "Jira project")}`,
  );
  if (projects.length === 0) throw new DevError("Your Atlassian account can't see any Jira projects.");

  const project = await searchPrompt(
    `Which Jira project? Type any part of its name or key (${projects.length} projects).`,
    projects.map((p) => ({ value: p.key, name: p.name, description: p.key })),
    "edit dev.yaml",
  );
  const filter = await choose(
    "Which tickets should dev keep?",
    [
      { value: "mine", name: `Assigned to me in ${project}, not done` },
      { value: "open", name: `Everything not done in ${project}` },
      { value: "custom", name: "My own JQL search" },
    ],
    "edit dev.yaml",
  );
  const jql =
    filter === "mine"
      ? `project = ${project} AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`
      : filter === "open"
        ? `project = ${project} AND statusCategory != Done ORDER BY updated DESC`
        : await ask("JQL search:", "edit dev.yaml", `project = ${project} AND statusCategory != Done ORDER BY updated DESC`);
  return { project, jql, attachments: true };
}

export const jira: Service = {
  id: "jira",
  title: "Jira",
  index: INDEX,
  description: "Tickets, one file per ticket",
  role: "connected",

  scope: {
    describe: (scope) => `${String(scope.jql ?? "no search yet")}${linkedProjects(scope).length > 0 ? `, and tickets linked from there in ${linkedProjects(scope).join(", ")}` : ""}`,
    choose: chooseScope,
    // The search decides what the work is. Adding a project only lets links into it be fetched.
    add(scope, items) {
      const list = linkedProjects(scope);
      const added: string[] = [];
      const problems = [];
      for (const item of items) {
        const project = projectFrom(item);
        if (!project) problems.push({ message: `"${item}" isn't a project key, a ticket key or a ticket's link.` });
        else if (!list.includes(project) && !added.includes(project)) added.push(project);
      }
      return { scope: { ...scope, linkedProjects: [...list, ...added] }, added, problems };
    },
    remove(scope, items) {
      const list = linkedProjects(scope);
      const removed = items.map((item) => projectFrom(item) ?? item).filter((project) => list.includes(project));
      const next: Scope = { ...scope, linkedProjects: list.filter((project) => !removed.includes(project)) };
      if ((next.linkedProjects as string[]).length === 0) delete next.linkedProjects;
      return { scope: next, removed, problems: items.filter((item) => !list.includes(projectFrom(item) ?? item)).map((item) => ({ message: `"${item}" isn't in the scope's linked projects.` })) };
    },
    validate(scope) {
      if (scope.attachments !== undefined && typeof scope.attachments !== "boolean") return [{ message: '"attachments" should be true or false.' }];
      if (scope.linkedProjects !== undefined && (!Array.isArray(scope.linkedProjects) || !scope.linkedProjects.every((p) => /^[A-Z][A-Z0-9]{1,9}$/.test(String(p))))) return [{ message: '"linkedProjects" should be a list of project keys, like [ABC, OPS].' }];
      if (typeof scope.jql !== "string" || !scope.jql.trim()) return [{ message: 'needs a "jql" search, like: assignee = currentUser() AND statusCategory != Done.' }];
      if (scope.project !== undefined && typeof scope.project !== "string") return [{ message: '"project" should be a project key, like ABC.' }];
      return [];
    },
  },

  sync,

  tasks: {
    async list(context) {
      // Every ticket in the workspace, in scope or fetched as a parent or link: an open one's
      // references matter either way.
      return (await localItems(context)).map((item) => ({
          id: item.key,
          title: String(item.data.title ?? ""),
          status: String(item.data.status ?? ""),
          done: item.data.statusCategory === "done",
          mine: item.data.mine === true,
          inScope: item.data.inScope === true,
          via: typeof item.data.via === "string" ? item.data.via : item.data.inScope === true ? "scope" : "linked",
          ...(typeof item.data.synced === "string" ? { synced: item.data.synced } : {}),
          ...(typeof item.data.due === "string" && item.data.due ? { due: item.data.due } : {}),
          file: `jira/${item.key}/${TICKET}`,
          ...(typeof item.data.parent === "string" && existsSync(file(context, item.data.parent)) ? { related: [`jira/${item.data.parent}/${TICKET}`] } : {}),
        }));
    },
  },

  links: {
    find(text, context) {
      // Without projects in the scope, a bare key is a guess: UTF-8 and SHA-256 look like keys too.
      const guess = scopeProjects(context.scope).length === 0;
      const keys: Reference[] = keysIn(text, context.scope).map((id) => ({ service: SERVICE, id, ...(guess ? { uncertain: true } : {}) }));
      // Browse links count whatever the project, since they can't be lookalikes.
      for (const match of text.matchAll(/https?:\/\/[\w.-]+(?::\d+)?\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)/g)) {
        if (match[1] && !keys.some((k) => k.id === match[1])) keys.push({ service: SERVICE, id: match[1], url: match[0] });
        else { const known = keys.find((k) => k.id === match[1]); if (known) { known.url = match[0]; delete known.uncertain; } }
      }
      return keys;
    },
    fetch: fetchOne,
    local: async (context, reference) => (existsSync(file(context, reference.id)) ? file(context, reference.id) : null),
  },

  contribute: {
    async taskStart(context, reference) {
      const target = await fetchOne(context, reference);
      const { data, body } = splitFrontMatter(await readFile(target, "utf8"));
      const files = [path.relative(context.root, target)];
      let text = body;

      // The spec often lives on the parent: fetch it, and follow its links too.
      if (typeof data?.parent === "string") {
        try {
          const parent = await fetchOne(context, { service: SERVICE, id: data.parent }, "parent");
          files.push(path.relative(context.root, parent));
          text += `\n${splitFrontMatter(await readFile(parent, "utf8")).body}`;
        } catch (error) {
          context.out.warn(`Couldn't fetch the parent ${data.parent}: ${(error as Error).message}`);
        }
      }
      const notFetched: string[] = [];
      for (const found of await context.references(text)) {
        if (found.file) files.push(found.file);
        else if (found.outside) notFetched.push(describeOutside(found));
      }

      return { title: String(data?.title ?? reference.id), type: branchType(String(data?.type ?? "")), files, references: [], notFetched };
    },

    async snapshot(context) {
      const today = new Date().toLocaleDateString("en-CA");
      const open = (await localItems(context)).filter((i) => i.data.inScope === true && i.data.statusCategory !== "done");
      if (open.length === 0) return null;
      const line = (i: { key: string; data: Record<string, unknown> }) =>
        `- [${i.key}](jira/${i.key}/${TICKET}) [${String(i.data.status)}] ${String(i.data.title)}${i.data.due ? ` · due ${String(i.data.due)}` : ""}`;
      const due = open.filter((i) => typeof i.data.due === "string" && i.data.due && i.data.due <= today);
      const progress = open.filter((i) => !due.includes(i) && i.data.statusCategory === "indeterminate");
      const todo = open.filter((i) => !due.includes(i) && !progress.includes(i));
      const section = (title: string, items: typeof open) => (items.length > 0 ? [`### ${title} (${items.length})`, "", ...items.map(line), ""] : []);
      return ["## Jira", "", ...section("Due today or overdue", due), ...section("In progress", progress), ...section("To do", todo)].join("\n").trim();
    },

    async sessionStart(context) {
      const today = new Date().toLocaleDateString("en-CA");
      const due = (await localItems(context)).filter((i) => i.data.inScope === true && i.data.statusCategory !== "done" && typeof i.data.due === "string" && i.data.due && i.data.due <= today);
      return due.length === 0 ? [] : [`Jira tickets due today or overdue: ${due.slice(0, 8).map((i) => `${i.key} ${String(i.data.title)}`).join("; ")}${due.length > 8 ? `, and ${due.length - 8} more` : ""}.`];
    },

    async dayEnd(context, date) {
      return (await localItems(context)).filter((i) => String(i.data.updated ?? "").startsWith(date)).map((i) => `- ${i.key} [${String(i.data.status)}] ${String(i.data.title)}`);
    },
  },

  commands: [
    {
      name: "pull",
      description: "Pull specific tickets in full, within the configured fetch boundary",
      mark: "read",
      writes: true,
      arguments: ["<keys...>"],
      async run(context, args) {
        for (const key of args) {
          if (!/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key)) throw new DevError(`"${key}" isn't a ticket key, like ABC-123.`);
          await fetchOne(context, { service: SERVICE, id: key }, "pulled");
          context.out.info(`jira/${key}/${TICKET}`);
        }
      },
    },
  ],

  agentFiles: {
    rules: ["Never comment on, edit or move a Jira ticket unless the person asks you to in this conversation. Read tickets from jira/, not from the Jira website."],
    docs: [
      {
        file: "jira.md",
        content: `# Jira in this workspace

Each ticket has its own folder, \`jira/<KEY>/\`. A sync only ever writes \`ticket.md\` and the
ticket's own attachments, in \`attachments/\`, there: notes, research or images you add next
to them are never touched.

## Finding tickets

- **What's yours or what to work on:** run \`dev task list --mine\` (or \`dev task list\` for
  everything open in scope). It says when the data was last synced.
- **Anything else:** read \`jira/index.md\`, then open only the tickets you need.

The index's **Why** column says why each ticket is here:

| Why | Meaning |
| --- | --- |
| scope | Matches the workspace's Jira search: the work this workspace follows |
| parent | The parent of an open ticket in scope. Specs often live here |
| linked | A task, PR or brief points to it |
| pulled | Someone pulled it by hand with \`dev jira pull\` |
| former | It was in scope, and has left it |

Only **scope** tickets are the work. The rest are context, unless the **Mine** column says
it's assigned to the person.

## Inside ticket.md

The front matter holds the status, type, priority, assignee, due date, points and parent.
The body has the description, the acceptance criteria field, relations, attachments and
comments. Acceptance criteria are often written in the description rather than in their
own field, and on a sub-task, in the parent's description.

Attachments are files in the ticket's \`attachments/\` folder, and images in the text point
to them. Links to tickets, pages and issues that are in the workspace point to the local
files; the original address is kept as the link's title. A link that is still a web address
has no local copy. If it's outside the scope, the ticket ends with an "Outside the scope"
section giving the exact command that adds it.

## Commands

| Command | Does |
| --- | --- |
| \`dev task list --mine\` | Your open tickets |
| \`dev jira pull <KEY>\` | Pull a ticket now, within the configured fetch boundary |
| \`dev task start <KEY>\` | Set up work on a ticket, with its parent and linked pages |
| \`dev jira scope\` | Show the search that defines the scope |

Changing the scope, and anything that changes Jira, is the person's call.`,
      },
    ],
  },
};

/** The Jira projects fetches may reach: the scope's own, or for a JQL-only scope, those of the tickets it returns. null: anywhere. */
const boundaries = new WeakMap<ServiceContext, string[] | null>();

function boundaryOf(context: ServiceContext, inScopeKeys: Iterable<string>): string[] | null {
  if (context.settings.fetch === "anywhere") return null;
  const projects = scopeProjects(context.scope);
  return [...new Set([...(projects.length > 0 ? projects : [...inScopeKeys].map((key) => key.split("-")[0] ?? "")), ...linkedProjects(context.scope)])];
}

async function boundary(context: ServiceContext): Promise<string[] | null> {
  if (!boundaries.has(context)) {
    const local = context.settings.fetch === "anywhere" || scopeProjects(context.scope).length > 0 ? [] : await localItems(context);
    boundaries.set(context, boundaryOf(context, local.filter((item) => item.data.inScope === true).map((item) => item.key)));
  }
  return boundaries.get(context) ?? null;
}

async function projectAllowed(context: ServiceContext, key: string): Promise<boolean> {
  const projects = await boundary(context);
  return projects === null || projects.includes(key.split("-")[0] ?? "");
}
