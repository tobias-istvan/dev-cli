import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Reference, Service, ServiceContext, SyncReport } from "../types.ts";
import { splitFrontMatter, updateFields, writeItem, type Via } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { DevError, OutsideScope } from "../../core/output.ts";
import { choose } from "../../core/prompt.ts";
import { loadConfig } from "../../core/project-config.ts";
import { GitHubApi, webBase } from "./api.ts";

/**
 * GitHub Issues: a task source, like Jira. Each issue has its own folder,
 * github-issues/<owner>-<repo>-<number>/issue.md, so notes can sit beside it.
 *
 * The scope is a list of repositories (by default the workspace's own) and whether to keep
 * every open issue or only those assigned to you.
 */

const SERVICE = "github:github-issues";
const ISSUE = "issue.md";

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  updated_at: string;
  user: { login: string };
  assignees?: Array<{ login: string }>;
  labels?: Array<{ name: string } | string>;
  milestone?: { title: string; due_on: string | null } | null;
  pull_request?: unknown;
  comments: number;
}

interface Comment {
  user?: { login?: string };
  body?: string | null;
  created_at?: string;
}

function repos(context: ServiceContext): string[] {
  const listed = Array.isArray(context.scope.repos) ? context.scope.repos.map(String) : [];
  if (listed.length > 0) return listed;
  const own = loadConfig(context.root).versioning?.repo;
  return own ? [own] : [];
}

function folder(context: ServiceContext): string {
  return context.folder ?? path.join(context.root, "github-issues");
}

function key(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function dirName(repo: string, number: number): string {
  return `${repo.replace("/", "-")}-${number}`;
}

function file(context: ServiceContext, repo: string, number: number): string {
  return path.join(folder(context), dirName(repo, number), ISSUE);
}

function labelNames(issue: Issue): string[] {
  return (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
}

async function write(context: ServiceContext, api: GitHubApi, repo: string, issue: Issue, me: string, via: Via): Promise<"added" | "updated" | "unchanged"> {
  const comments = issue.comments > 0 ? await api.list<Comment>(`/repos/${repo}/issues/${issue.number}/comments`) : [];
  const assignees = (issue.assignees ?? []).map((a) => a.login);
  const labels = labelNames(issue);

  const body = [
    `# ${key(repo, issue.number)}: ${issue.title}`,
    "",
    [`**State:** ${issue.state}`, `**Opened by:** ${issue.user.login}`, ...(assignees.length > 0 ? [`**Assigned:** ${assignees.join(", ")}`] : []), ...(labels.length > 0 ? [`**Labels:** ${labels.join(", ")}`] : [])].join(" · "),
    "",
    "## Description",
    "",
    (issue.body ?? "").trim() || "_No description._",
    "",
    `## Comments (${comments.length})`,
    "",
    comments.length > 0
      ? comments.map((c) => `### ${c.user?.login ?? "unknown"} · ${(c.created_at ?? "").slice(0, 16).replace("T", " ")}\n\n${(c.body ?? "").trim() || "_(empty)_"}`).join("\n\n")
      : "_No comments._",
  ].join("\n");

  return writeItem(
    file(context, repo, issue.number),
    {
      id: key(repo, issue.number),
      title: issue.title,
      service: SERVICE,
      url: issue.html_url,
      updated: issue.updated_at,
      synced: new Date().toISOString(),
      status: issue.state,
      repo,
      number: issue.number,
      assignees,
      labels,
      mine: assignees.includes(me),
      due: issue.milestone?.due_on?.slice(0, 10) ?? "",
      inScope: via === "scope",
      via,
    },
    body,
  );
}

async function localItems(context: ServiceContext): Promise<Array<{ dir: string; data: Record<string, unknown> }>> {
  if (!existsSync(folder(context))) return [];
  const items: Array<{ dir: string; data: Record<string, unknown> }> = [];
  for (const entry of await readdir(folder(context), { withFileTypes: true })) {
    const target = path.join(folder(context), entry.name, ISSUE);
    if (!entry.isDirectory() || !existsSync(target)) continue;
    const { data } = splitFrontMatter(await readFile(target, "utf8"));
    if (data) items.push({ dir: entry.name, data });
  }
  return items;
}

function index(context: ServiceContext): void {
  if (existsSync(folder(context))) buildIndex(folder(context), "GitHub issues", (f) => path.posix.basename(f) === ISSUE);
}

async function sync(context: ServiceContext): Promise<SyncReport> {
  const api = GitHubApi.from(context.credentials());
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const me = (await api.get<{ login: string }>("/user")).login;
  const mineOnly = context.scope.assigned !== "any";
  const local = await localItems(context);
  const known = new Map(local.map((item) => [String(item.data.id), item.data]));
  const seen = new Set<string>();

  for (const repo of repos(context)) {
    let issues: Issue[];
    try {
      issues = (await api.list<Issue>(`/repos/${repo}/issues?state=open${mineOnly ? `&assignee=${encodeURIComponent(me)}` : ""}`)).filter((i) => !i.pull_request);
    } catch (error) {
      report.failed.push({ id: repo, reason: (error as Error).message });
      continue;
    }
    for (const issue of issues) {
      const id = key(repo, issue.number);
      seen.add(id);
      const existing = known.get(id);
      if (existing && existing.updated === issue.updated_at && existing.inScope === true) continue;
      try {
        const result = await write(context, api, repo, issue, me, "scope");
        if (result === "added") report.added++;
        else if (result === "updated") report.updated++;
      } catch (error) {
        report.failed.push({ id, reason: (error as Error).message });
      }
    }
  }

  // Issues that were in scope and aren't any more: closed ones are refreshed, so they show as
  // done; the rest stay, marked as formerly in scope.
  for (const item of local) {
    const id = String(item.data.id);
    if (item.data.inScope !== true || seen.has(id)) continue;
    const repo = String(item.data.repo);
    try {
      const issue = await api.get<Issue>(`/repos/${repo}/issues/${String(item.data.number)}`);
      if (issue.state === "closed") {
        if ((await write(context, api, repo, issue, me, "scope")) !== "unchanged") report.updated++;
      } else if (await updateFields(path.join(folder(context), item.dir, ISSUE), { inScope: false, via: "former" })) {
        report.removed++;
      }
    } catch (error) {
      report.failed.push({ id, reason: (error as Error).message });
    }
  }

  index(context);
  return report;
}

/** owner/name#N, github.com/owner/name/issues/N, or "closes #N" for the workspace's own repository. */
function find(text: string, context: ServiceContext | null): Reference[] {
  const found = new Map<string, Reference>();
  const add = (repo: string, number: string, url?: string) => {
    const id = key(repo, Number(number));
    if (!found.has(id)) found.set(id, { service: SERVICE, id, ...(url ? { url } : {}) });
  };
  const host = webBase().replace(/^https?:\/\//, "").replace(/[.]/g, "\\.");
  for (const match of text.matchAll(new RegExp(`https?://${host}/([\\w.-]+/[\\w.-]+)/issues/(\\d+)`, "g"))) {
    if (match[1] && match[2]) add(match[1], match[2], match[0]);
  }
  for (const match of text.matchAll(/(?<![\w/])([\w.-]+\/[\w.-]+)#(\d+)\b/g)) {
    if (match[1] && match[2]) add(match[1], match[2]);
  }
  // A bare #N is ambiguous with PR numbers, so only the closing keywords count.
  const own = context ? repos(context)[0] : undefined;
  if (own) {
    for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) {
      if (match[1]) add(own, match[1]);
    }
  }
  return [...found.values()];
}

function parseKey(id: string): { repo: string; number: number } {
  const match = id.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!match?.[1] || !match[2]) throw new DevError(`"${id}" isn't an issue, like owner/name#42.`);
  return { repo: match[1], number: Number(match[2]) };
}

async function fetchOne(context: ServiceContext, reference: Reference, via: Via = "linked"): Promise<string> {
  const { repo, number } = parseKey(reference.id);
  if (context.settings.fetch === "within-scope" && !repos(context).includes(repo)) throw new OutsideScope(`GitHub issue ${reference.id}`);
  const api = GitHubApi.from(context.credentials());
  const issue = await api.get<Issue>(`/repos/${repo}/issues/${number}`);
  if (issue.pull_request) throw new DevError(`${reference.id} is a pull request, not an issue.`);

  const target = file(context, repo, number);
  let reason = via;
  if (existsSync(target)) {
    const data = splitFrontMatter(await readFile(target, "utf8")).data;
    if (data?.via === "scope") reason = "scope";
  }
  const me = (await api.get<{ login: string }>("/user")).login;
  await write(context, api, repo, issue, me, reason);
  index(context);
  return target;
}

/** Accepts owner/name#N, a URL, or a bare number in the workspace's own repository. */
function referenceFrom(context: ServiceContext, word: string): Reference {
  if (/^#?\d+$/.test(word)) {
    const own = repos(context)[0];
    if (!own) throw new DevError("No repository to look the issue number up in.");
    return { service: SERVICE, id: key(own, Number(word.replace("#", ""))) };
  }
  const found = find(word, null);
  if (!found[0]) throw new DevError(`"${word}" isn't an issue, like owner/name#42 or its link.`);
  return found[0];
}

export const issues: Service = {
  id: "github-issues",
  title: "GitHub Issues",
  description: "Issues, one folder per issue",
  role: "connected",

  scope: {
    describe(scope) {
      const list = Array.isArray(scope.repos) && scope.repos.length > 0 ? scope.repos.join(", ") : "the workspace's repository";
      return `${scope.assigned === "any" ? "every open issue" : "open issues assigned to you"} in ${list}`;
    },
    async choose() {
      const assigned = await choose(
        "Which issues should dev keep?",
        [
          { value: "me", name: "Open issues assigned to me" },
          { value: "any", name: "Every open issue" },
        ],
        "edit dev.yaml",
      );
      return { assigned };
    },
    validate(scope) {
      if (scope.assigned !== undefined && scope.assigned !== "me" && scope.assigned !== "any") return [{ message: '"assigned" should be me or any.' }];
      if (scope.repos !== undefined && (!Array.isArray(scope.repos) || !scope.repos.every((r) => /^[\w.-]+\/[\w.-]+$/.test(String(r))))) {
        return [{ message: '"repos" should be a list like [owner/name].' }];
      }
      return [];
    },
    add(scope, items) {
      const list = Array.isArray(scope.repos) ? scope.repos.map(String) : [];
      const added: string[] = [];
      const problems = [];
      for (const item of items) {
        const repo = item.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "").replace(/\/$/, "");
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) problems.push({ message: `"${item}" isn't a repository, like owner/name.` });
        else if (!list.includes(repo) && !added.includes(repo)) added.push(repo);
      }
      return { scope: { ...scope, repos: [...list, ...added] }, added, problems };
    },
  },

  sync,

  tasks: {
    async list(context) {
      return (await localItems(context)).map((item) => ({
        id: String(item.data.id),
        title: String(item.data.title ?? ""),
        status: String(item.data.status ?? ""),
        done: item.data.status === "closed",
        mine: item.data.mine === true,
        inScope: item.data.inScope === true,
        via: typeof item.data.via === "string" ? item.data.via : "linked",
        ...(typeof item.data.due === "string" && item.data.due ? { due: item.data.due } : {}),
        ...(typeof item.data.synced === "string" ? { synced: item.data.synced } : {}),
        file: `github-issues/${item.dir}/${ISSUE}`,
      }));
    },
  },

  links: { find: (text, context) => find(text, context), fetch: (context, reference) => fetchOne(context, reference) },

  contribute: {
    async taskStart(context, reference) {
      const target = await fetchOne(context, reference);
      const { data, body } = splitFrontMatter(await readFile(target, "utf8"));
      const files = [path.relative(context.root, target)];
      const notFetched: string[] = [];
      for (const found of await context.references(body)) {
        if (found.file) files.push(found.file);
        else if (found.outside) notFetched.push(found.reference.url ?? found.reference.id);
      }
      const labels = Array.isArray(data?.labels) ? data.labels.map(String) : [];
      return {
        title: String(data?.title ?? reference.id),
        type: labels.some((l) => /bug|defect/i.test(l)) ? "fix" : labels.some((l) => /chore|task/i.test(l)) ? "chore" : "feature",
        files,
        references: [],
        notFetched,
      };
    },

    async snapshot(context) {
      const open = (await localItems(context)).filter((i) => i.data.inScope === true && i.data.status !== "closed");
      if (open.length === 0) return null;
      const lines = open
        .sort((a, b) => Number(b.data.mine === true) - Number(a.data.mine === true))
        .map((i) => `- [${String(i.data.id)}](github-issues/${i.dir}/${ISSUE}) ${String(i.data.title)}${i.data.mine === true ? " · mine" : ""}`);
      return ["## GitHub issues", "", ...lines].join("\n");
    },

    async dayEnd(context, date) {
      return (await localItems(context)).filter((i) => String(i.data.updated ?? "").startsWith(date)).map((i) => `- ${String(i.data.id)} [${String(i.data.status)}] ${String(i.data.title)}`);
    },
  },

  commands: [
    {
      name: "pull",
      description: "Pull specific issues, in scope or not",
      mark: "read",
      arguments: ["<issues...>"],
      help: "Each issue is owner/name#42, its link, or a number in the workspace's repository.",
      async run(context, args) {
        for (const word of args) {
          const target = await fetchOne(context, referenceFrom(context, word), "pulled");
          context.out.info(path.relative(context.root, target));
        }
      },
    },
  ],

  agentFiles: {
    rules: ["Never comment on, label, assign or close a GitHub issue unless the person asks you to in this conversation."],
  },
};
