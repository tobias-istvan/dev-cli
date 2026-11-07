import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Reference, Scope, Service, ServiceContext, SyncReport } from "../types.ts";
import { splitFrontMatter, writeItem } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { DevError } from "../../core/output.ts";
import { ask, choose, search as searchPrompt } from "../../core/prompt.ts";
import { AtlassianClient, limiter, siteFrom } from "./client.ts";
import { htmlToMarkdown } from "./html.ts";

/**
 * Jira: the tickets in scope, one Markdown file each as jira/<KEY>.md. The scope is a JQL
 * search. Tickets fetched on demand, like a parent or one named in a PR, are kept too,
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
    assignee?: { displayName?: string } | null;
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
    attachment?: Array<{ filename: string; size?: number }>;
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

function file(context: ServiceContext, key: string): string {
  return path.join(folder(context), `${key}.md`);
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

/** Custom fields differ per site, so they're found by name. */
async function customFields(api: AtlassianClient): Promise<{ acceptance: string | null; points: string | null }> {
  const fields = await api.get<Array<{ id: string; name: string }>>("/rest/api/3/field");
  const find = (pattern: RegExp) => fields.find((f) => pattern.test(f.name))?.id ?? null;
  return { acceptance: find(/^acceptance criteria$/i), points: find(/^story point(s| estimate)$/i) };
}

function branchType(issueType: string): string {
  if (/bug|defect/i.test(issueType)) return "fix";
  if (/task|chore|spike/i.test(issueType)) return "chore";
  return "feature";
}

/** Renders one issue. Related issues link to their local file when it's there, else to Jira. */
async function render(context: ServiceContext, api: AtlassianClient, issue: Issue, ids: { acceptance: string | null; points: string | null }, inScope: boolean): Promise<"added" | "updated" | "unchanged"> {
  const f = issue.fields;
  const rendered = issue.renderedFields ?? {};
  const html = (value: unknown) => (typeof value === "string" ? value : "");
  const description = htmlToMarkdown(html(rendered.description)) || "_No description._";
  const acceptance = ids.acceptance ? htmlToMarkdown(html(rendered[ids.acceptance])) : "";
  const points = ids.points && typeof f[ids.points] === "number" ? (f[ids.points] as number) : null;

  const link = (key: string) => (existsSync(file(context, key)) ? `[${key}](${key}.md)` : `[${key}](${api.browseUrl(key)})`);
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
    (f.attachment ?? []).length > 0 ? (f.attachment ?? []).map((a) => `- ${a.filename}${a.size ? ` (${Math.round(a.size / 1024)} KB)` : ""}`).join("\n") : "_None._",
    "",
    `## Comments (${comments.length})`,
    "",
    commentText || "_No comments._",
  ].join("\n");

  return writeItem(
    file(context, issue.key),
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
      due: f.duedate ?? "",
      points,
      labels: f.labels ?? [],
      inScope,
    },
    body,
  );
}

async function fetchIssue(api: AtlassianClient, key: string): Promise<Issue> {
  return api.get<Issue>(`/rest/api/3/issue/${encodeURIComponent(key)}?expand=renderedFields`);
}

async function localItems(context: ServiceContext): Promise<Array<{ key: string; data: Record<string, unknown> }>> {
  if (!existsSync(folder(context))) return [];
  const items: Array<{ key: string; data: Record<string, unknown> }> = [];
  for (const name of await readdir(folder(context))) {
    if (!name.endsWith(".md") || name === "index.md") continue;
    const { data } = splitFrontMatter(await readFile(path.join(folder(context), name), "utf8"));
    if (data) items.push({ key: name.slice(0, -3), data });
  }
  return items;
}

function index(context: ServiceContext): void {
  if (existsSync(folder(context))) buildIndex(folder(context), "Jira tickets");
}

async function sync(context: ServiceContext): Promise<SyncReport> {
  const jql = String(context.scope.jql ?? "");
  if (!jql) throw new DevError("Jira has no scope yet.", 'Run "dev jira scope".');
  const api = client(context);
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };

  const [found, ids, local] = await Promise.all([search(api, jql, LIST_FIELDS), customFields(api), localItems(context)]);
  const known = new Map(local.map((item) => [item.key, item.data]));
  const inScope = new Set(found.map((issue) => issue.key));
  const limit = limiter(4);

  await Promise.all(
    found.map((summary) =>
      limit(async () => {
        const existing = known.get(summary.key);
        // Unchanged in Jira and already marked in scope: nothing to fetch.
        if (existing && existing.updated === summary.fields.updated && existing.inScope === true) return;
        try {
          const result = await render(context, api, await fetchIssue(api, summary.key), ids, true);
          if (result === "added") report.added++;
          else if (result === "updated") report.updated++;
        } catch (error) {
          report.failed.push({ id: summary.key, reason: (error as Error).message });
        }
      }),
    ),
  );

  // Tickets that left the scope go. Ones fetched on demand were never in it, and stay.
  for (const item of local) {
    if (item.data.inScope === true && !inScope.has(item.key)) {
      await rm(file(context, item.key), { force: true });
      report.removed++;
    }
  }

  index(context);
  return report;
}

function keysIn(text: string, scope: Scope): string[] {
  const projects = Array.isArray(scope.projects) ? scope.projects.map(String) : typeof scope.project === "string" ? [scope.project] : [];
  const keys = new Set<string>();
  for (const match of text.matchAll(KEY)) {
    // Without known projects, any KEY-123 counts; with them, lookalikes like UTF-8 don't.
    if (projects.length === 0 || projects.includes(match[1] ?? "")) keys.add(match[0]);
  }
  return [...keys];
}

async function fetchOne(context: ServiceContext, reference: Reference): Promise<string> {
  const api = client(context);
  const target = file(context, reference.id);
  let inScope = false;
  if (existsSync(target)) inScope = splitFrontMatter(await readFile(target, "utf8")).data?.inScope === true;
  await render(context, api, await fetchIssue(api, reference.id), await customFields(api), inScope);
  index(context);
  return target;
}

async function chooseScope(context: ServiceContext): Promise<Scope> {
  const api = client(context);
  context.out.info("Loading projects...");
  const projects: Array<{ key: string; name: string }> = [];
  let start = 0;
  for (;;) {
    const page = await api.get<{ values: Array<{ key: string; name: string }>; isLast?: boolean }>(`/rest/api/3/project/search?maxResults=100&startAt=${start}`);
    projects.push(...page.values);
    if (page.isLast !== false || page.values.length === 0) break;
    start += page.values.length;
  }
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
  return { project, jql };
}

export const jira: Service = {
  id: "jira",
  title: "Jira",
  description: "Tickets, one file per ticket",
  role: "connected",

  scope: {
    describe: (scope) => String(scope.jql ?? "no search yet"),
    choose: chooseScope,
    validate(scope) {
      if (typeof scope.jql !== "string" || !scope.jql.trim()) return [{ message: 'needs a "jql" search, like: assignee = currentUser() AND statusCategory != Done.' }];
      if (scope.project !== undefined && typeof scope.project !== "string") return [{ message: '"project" should be a project key, like ABC.' }];
      return [];
    },
  },

  sync,

  links: {
    find(text, scope) {
      const keys = keysIn(text, scope).map((id) => ({ service: SERVICE, id }));
      // Browse links count whatever the project, since they can't be lookalikes.
      for (const match of text.matchAll(/https?:\/\/[\w.-]+(?::\d+)?\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)/g)) {
        if (match[1] && !keys.some((k) => k.id === match[1])) keys.push({ service: SERVICE, id: match[1] });
      }
      return keys;
    },
    fetch: fetchOne,
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
          const parent = await fetchOne(context, { service: SERVICE, id: data.parent });
          files.push(path.relative(context.root, parent));
          text += `\n${splitFrontMatter(await readFile(parent, "utf8")).body}`;
        } catch (error) {
          context.out.warn(`Couldn't fetch the parent ${data.parent}: ${(error as Error).message}`);
        }
      }
      for (const found of await context.references(text)) if (found.file) files.push(found.file);

      return { title: String(data?.title ?? reference.id), type: branchType(String(data?.type ?? "")), files, references: [] };
    },

    async snapshot(context) {
      const today = new Date().toLocaleDateString("en-CA");
      const open = (await localItems(context)).filter((i) => i.data.inScope === true && i.data.statusCategory !== "done");
      if (open.length === 0) return null;
      const line = (i: { key: string; data: Record<string, unknown> }) =>
        `- [${i.key}](jira/${i.key}.md) [${String(i.data.status)}] ${String(i.data.title)}${i.data.due ? ` · due ${String(i.data.due)}` : ""}`;
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
      description: "Pull specific tickets in full, in scope or not",
      mark: "read",
      arguments: ["<keys...>"],
      async run(context, args) {
        for (const key of args) {
          if (!/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key)) throw new DevError(`"${key}" isn't a ticket key, like ABC-123.`);
          await fetchOne(context, { service: SERVICE, id: key });
          context.out.info(`jira/${key}.md`);
        }
      },
    },
  ],

  agentFiles: {
    rules: ["Never comment on, edit or move a Jira ticket unless the person asks you to in this conversation. Read tickets from jira/, not from the Jira website."],
  },
};
