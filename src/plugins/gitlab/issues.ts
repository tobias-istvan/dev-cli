import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Reference, Service, ServiceContext, SyncReport } from "../types.ts";
import { splitFrontMatter, updateFields, writeItem, type Via } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { DevError, OutsideScope, describeError } from "../../core/output.ts";
import { choose } from "../../core/prompt.ts";
import { loadConfig } from "../../core/project-config.ts";
import { GitLabApi, projectId } from "./api.ts";

/**
 * GitLab Issues: a task source, each issue in gitlab-issues/<group>-<project>-<iid>/issue.md.
 * The scope is a list of projects (by default the workspace's own) and whether to keep every
 * open issue or only yours.
 */

const SERVICE = "gitlab:gitlab-issues";
const ISSUE = "issue.md";

interface Issue {
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
  updated_at: string;
  due_date: string | null;
  author: { username: string };
  assignees?: Array<{ username: string }>;
  labels?: string[];
  user_notes_count: number;
}

interface Note {
  author?: { username?: string };
  body?: string;
  created_at?: string;
  system?: boolean;
}

function projects(context: ServiceContext): string[] {
  const listed = Array.isArray(context.scope.projects) ? context.scope.projects.map(String) : [];
  if (listed.length > 0) return listed;
  const config = loadConfig(context.root);
  return config.versioning?.service === "gitlab:gitlab" && config.versioning.repo ? [config.versioning.repo] : [];
}

function folder(context: ServiceContext): string {
  return context.folder ?? path.join(context.root, "gitlab-issues");
}

const key = (project: string, iid: number) => `${project}#${iid}`;
const dirName = (project: string, iid: number) => `${project.replace(/\//g, "-")}-${iid}`;

function file(context: ServiceContext, project: string, iid: number): string {
  return path.join(folder(context), dirName(project, iid), ISSUE);
}

async function write(context: ServiceContext, api: GitLabApi, project: string, issue: Issue, me: string, via: Via): Promise<"added" | "updated" | "unchanged"> {
  const notes = issue.user_notes_count > 0 ? (await api.list<Note>(`/projects/${projectId(project)}/issues/${issue.iid}/notes?sort=asc`)).filter((n) => !n.system) : [];
  const assignees = (issue.assignees ?? []).map((a) => a.username);
  const labels = issue.labels ?? [];
  return writeItem(
    file(context, project, issue.iid),
    {
      id: key(project, issue.iid),
      title: issue.title,
      service: SERVICE,
      url: issue.web_url,
      updated: issue.updated_at,
      synced: new Date().toISOString(),
      status: issue.state === "opened" ? "open" : "closed",
      project,
      iid: issue.iid,
      assignees,
      labels,
      mine: assignees.includes(me),
      due: issue.due_date ?? "",
      inScope: via === "scope",
      via,
    },
    [
      `# ${key(project, issue.iid)}: ${issue.title}`,
      "",
      [`**State:** ${issue.state === "opened" ? "open" : "closed"}`, `**Opened by:** ${issue.author.username}`, ...(assignees.length > 0 ? [`**Assigned:** ${assignees.join(", ")}`] : []), ...(labels.length > 0 ? [`**Labels:** ${labels.join(", ")}`] : [])].join(" · "),
      "",
      "## Description",
      "",
      (issue.description ?? "").trim() || "_No description._",
      "",
      `## Comments (${notes.length})`,
      "",
      notes.length > 0 ? notes.map((n) => `### ${n.author?.username ?? "unknown"} · ${(n.created_at ?? "").slice(0, 16).replace("T", " ")}\n\n${(n.body ?? "").trim() || "_(empty)_"}`).join("\n\n") : "_No comments._",
    ].join("\n"),
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
  if (existsSync(folder(context))) buildIndex(folder(context), "GitLab issues", (f) => path.posix.basename(f) === ISSUE);
}

async function sync(context: ServiceContext): Promise<SyncReport> {
  const api = GitLabApi.from(context.credentials());
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const me = (await api.get<{ username: string }>("/user")).username;
  const mineOnly = context.scope.assigned !== "any";
  const local = await localItems(context);
  const known = new Map(local.map((item) => [String(item.data.id), item.data]));
  const seen = new Set<string>();

  for (const project of projects(context)) {
    let issues: Issue[];
    try {
      issues = await api.list<Issue>(`/projects/${projectId(project)}/issues?state=opened${mineOnly ? `&assignee_username=${encodeURIComponent(me)}` : ""}`);
    } catch (error) {
      report.failed.push({ id: project, reason: describeError(error) });
      continue;
    }
    for (const issue of issues) {
      const id = key(project, issue.iid);
      seen.add(id);
      const existing = known.get(id);
      if (existing && existing.updated === issue.updated_at && existing.inScope === true) continue;
      try {
        const result = await write(context, api, project, issue, me, "scope");
        if (result === "added") report.added++;
        else if (result === "updated") report.updated++;
      } catch (error) {
        report.failed.push({ id, reason: describeError(error) });
      }
    }
  }

  for (const item of local) {
    const id = String(item.data.id);
    if (item.data.inScope !== true || seen.has(id)) continue;
    const project = String(item.data.project);
    try {
      const issue = await api.get<Issue>(`/projects/${projectId(project)}/issues/${String(item.data.iid)}`);
      if (issue.state === "closed") {
        if ((await write(context, api, project, issue, me, "scope")) !== "unchanged") report.updated++;
      } else if (await updateFields(path.join(folder(context), item.dir, ISSUE), { inScope: false, via: "former" })) {
        report.removed++;
      }
    } catch (error) {
      report.failed.push({ id, reason: describeError(error) });
    }
  }

  index(context);
  return report;
}

/** Only projects this workspace knows count, so a GitHub-style owner/name#N isn't claimed by mistake. */
function find(text: string, context: ServiceContext): Reference[] {
  const known = projects(context);
  const found = new Map<string, Reference>();
  const add = (project: string, iid: string, url?: string) => {
    const id = key(project, Number(iid));
    if (!found.has(id)) found.set(id, { service: SERVICE, id, ...(url ? { url } : {}) });
  };
  for (const match of text.matchAll(/https?:\/\/[\w.:-]+\/([\w.-]+(?:\/[\w.-]+)+)\/-\/issues\/(\d+)/g)) {
    if (match[1] && match[2]) add(match[1], match[2], match[0]);
  }
  for (const match of text.matchAll(/(?<![\w/])([\w.-]+(?:\/[\w.-]+)+)#(\d+)\b/g)) {
    if (match[1] && match[2] && known.includes(match[1])) add(match[1], match[2]);
  }
  if (known[0]) {
    for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|implement(?:s|ed)?)\s+#(\d+)\b/gi)) {
      if (match[1]) add(known[0], match[1]);
    }
  }
  return [...found.values()];
}

function parseKey(id: string): { project: string; iid: number } {
  const match = id.match(/^([\w.-]+(?:\/[\w.-]+)+)#(\d+)$/);
  if (!match?.[1] || !match[2]) throw new DevError(`"${id}" isn't an issue, like group/project#42.`);
  return { project: match[1], iid: Number(match[2]) };
}

async function fetchOne(context: ServiceContext, reference: Reference, via: Via = "linked"): Promise<string> {
  const { project, iid } = parseKey(reference.id);
  if (context.settings.fetch === "within-scope" && !projects(context).includes(project)) throw new OutsideScope(`GitLab issue ${reference.id}`);
  const api = GitLabApi.from(context.credentials());
  const issue = await api.get<Issue>(`/projects/${projectId(project)}/issues/${iid}`);
  const target = file(context, project, iid);
  let reason = via;
  if (existsSync(target) && splitFrontMatter(await readFile(target, "utf8")).data?.via === "scope") reason = "scope";
  await write(context, api, project, issue, (await api.get<{ username: string }>("/user")).username, reason);
  index(context);
  return target;
}

export const gitlabIssues: Service = {
  id: "gitlab-issues",
  title: "GitLab Issues",
  description: "Issues, one folder per issue",
  role: "connected",

  scope: {
    describe(scope) {
      const list = Array.isArray(scope.projects) && scope.projects.length > 0 ? scope.projects.join(", ") : "the workspace's project";
      return `${scope.assigned === "any" ? "every open issue" : "open issues assigned to you"} in ${list}`;
    },
    async choose() {
      return {
        assigned: await choose(
          "Which issues should dev keep?",
          [
            { value: "me", name: "Open issues assigned to me" },
            { value: "any", name: "Every open issue" },
          ],
          "edit dev.yaml",
        ),
      };
    },
    validate(scope) {
      if (scope.assigned !== undefined && scope.assigned !== "me" && scope.assigned !== "any") return [{ message: '"assigned" should be me or any.' }];
      if (scope.projects !== undefined && (!Array.isArray(scope.projects) || !scope.projects.every((p) => /^[\w.-]+(\/[\w.-]+)+$/.test(String(p))))) {
        return [{ message: '"projects" should be a list like [group/project].' }];
      }
      return [];
    },
    add(scope, items) {
      const list = Array.isArray(scope.projects) ? scope.projects.map(String) : [];
      const added: string[] = [];
      const problems = [];
      for (const item of items) {
        const project = item.replace(/^https?:\/\/[^/]+\//, "").replace(/\/-\/.*$/, "").replace(/\.git$/, "").replace(/\/$/, "");
        if (!/^[\w.-]+(\/[\w.-]+)+$/.test(project)) problems.push({ message: `"${item}" isn't a project, like group/project.` });
        else if (!list.includes(project) && !added.includes(project)) added.push(project);
      }
      return { scope: { ...scope, projects: [...list, ...added] }, added, problems };
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
        file: `gitlab-issues/${item.dir}/${ISSUE}`,
      }));
    },
  },

  links: { find, fetch: (context, reference) => fetchOne(context, reference) },

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
      return [
        "## GitLab issues",
        "",
        ...open
          .sort((a, b) => Number(b.data.mine === true) - Number(a.data.mine === true))
          .map((i) => `- [${String(i.data.id)}](gitlab-issues/${i.dir}/${ISSUE}) ${String(i.data.title)}${i.data.mine === true ? " · mine" : ""}`),
      ].join("\n");
    },
  },

  commands: [
    {
      name: "pull",
      description: "Pull specific issues, in scope or not",
      mark: "read",
      arguments: ["<issues...>"],
      help: "Each issue is group/project#42, its link, or a number in the workspace's project.",
      async run(context, args) {
        for (const word of args) {
          const own = projects(context)[0];
          const reference = /^#?\d+$/.test(word) && own ? { service: SERVICE, id: key(own, Number(word.replace("#", ""))) } : find(word, context)[0] ?? { service: SERVICE, id: word };
          const target = await fetchOne(context, reference, "pulled");
          context.out.info(path.relative(context.root, target));
        }
      },
    },
  ],

  agentFiles: {
    rules: ["Never comment on, label, assign or close a GitLab issue unless the person asks you to in this conversation."],
  },
};
