import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServiceContext, SyncReport } from "../types.ts";
import { splitFrontMatter, updateFields, writeItem } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { loadConfig } from "../../core/project-config.ts";
import { GitLabApi, projectId } from "./api.ts";

/**
 * Other people's merge requests, pulled into merge-requests/<iid>/ for review, the GitLab
 * twin of GitHub's pull requests. Only new or changed ones are fetched.
 */

export const FOLDER = "merge-requests";
export const DESCRIPTION = "mr-description.md";
export const REVIEW = "review.md";

type ReviewState = "new" | "updated" | "unreviewed" | "current";

interface Summary {
  iid: number;
  title: string;
  author: { username: string };
  draft?: boolean;
  work_in_progress?: boolean;
  updated_at: string;
  web_url: string;
}

interface Detail extends Summary {
  description: string | null;
  state: "opened" | "closed" | "merged" | "locked";
  source_branch: string;
  target_branch: string;
  source_project_id?: number;
  target_project_id?: number;
}

interface Note {
  author?: { username?: string };
  body?: string;
  created_at?: string;
  system?: boolean;
  position?: { new_path?: string; new_line?: number | null };
}

export interface PollResult {
  repo: string;
  open: number;
  considered: Array<{ number: number; title: string; author: string; state: ReviewState }>;
  finished: Array<{ number: number; state: string }>;
  report: SyncReport;
}

function folder(context: ServiceContext): string {
  return path.join(context.root, FOLDER);
}

function repository(context: ServiceContext): string {
  const repo = loadConfig(context.root).versioning?.repo;
  if (!repo) throw new Error("dev.yaml names no repository.");
  return repo;
}

async function frontMatter(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return splitFrontMatter(await readFile(path.join(dir, DESCRIPTION), "utf8")).data;
  } catch {
    return null;
  }
}

export function indexMerges(context: ServiceContext): void {
  if (existsSync(folder(context))) buildIndex(folder(context), "Merge requests under review", (f) => path.posix.basename(f) === DESCRIPTION);
}

/** Pulls one merge request. review.md is the reviewer's, and is never touched. */
export async function pullMerge(context: ServiceContext, api: GitLabApi, repo: string, iid: number): Promise<{ comments: number; links: string[]; head: string; fork: boolean }> {
  const base = `/projects/${projectId(repo)}/merge_requests/${iid}`;
  const [mr, diffs, notes] = await Promise.all([
    api.get<Detail>(base),
    api.list<{ new_path: string; new_file?: boolean; deleted_file?: boolean }>(`${base}/diffs`, 3000).catch(() => []),
    api.list<Note>(`${base}/notes?sort=asc`),
  ]);
  const comments = notes.filter((n) => !n.system && (n.body ?? "").trim());

  const references = await context.references(`${mr.title}\n${mr.description ?? ""}`);
  const links = references.map((r) => r.file ?? r.reference.url ?? r.reference.id);
  const linkLines = references.map((r) =>
    r.file
      ? `- ${r.reference.id}: [${r.file.split(path.sep).join("/")}](${path.posix.relative(`${FOLDER}/${iid}`, r.file.split(path.sep).join("/"))})`
      : `- ${r.reference.url ?? r.reference.id} (${r.outside ? "outside the scope, not fetched" : "not fetched"})`,
  );

  const dir = path.join(folder(context), String(iid));
  await mkdir(dir, { recursive: true });
  await writeItem(
    path.join(dir, DESCRIPTION),
    {
      id: String(iid),
      title: mr.title,
      service: "gitlab:gitlab",
      url: mr.web_url,
      updated: mr.updated_at,
      synced: new Date().toISOString(),
      status: mr.state === "merged" ? "merged" : mr.state === "opened" ? (mr.draft || mr.work_in_progress ? "draft" : "open") : "closed",
      links,
      author: mr.author.username,
      base: mr.target_branch,
      head: mr.source_branch,
    },
    [
      `# MR !${iid}: ${mr.title}`,
      "",
      `${mr.author.username} · \`${mr.source_branch}\` into \`${mr.target_branch}\` · [on GitLab](${mr.web_url})`,
      "",
      "## Linked items",
      "",
      linkLines.length > 0 ? linkLines.join("\n") : "_None found in the title or description._",
      "",
      "## Description",
      "",
      (mr.description ?? "").trim() || "_No description._",
      "",
      "## Changed files",
      "",
      ...diffs.map((d) => `- \`${d.new_path}\`${d.new_file ? " (new)" : d.deleted_file ? " (deleted)" : ""}`),
      "",
      `Read the diff with \`glab mr diff ${iid}\`. Write your review in review.md in this folder.`,
    ].join("\n"),
  );

  const body = comments.length === 0
    ? "_No comments._"
    : comments
        .map((n) => {
          const where = n.position?.new_path ? ` · \`${n.position.new_path}${n.position.new_line ? `:${n.position.new_line}` : ""}\`` : "";
          return `### ${n.author?.username ?? "unknown"} · ${(n.created_at ?? "").slice(0, 16).replace("T", " ")}${where}\n\n${(n.body ?? "").trim()}`;
        })
        .join("\n\n");
  await writeFile(path.join(dir, "comments.md"), `# MR !${iid}: comments\n\n${body}\n`);
  return { comments: comments.length, links, head: mr.source_branch, fork: mr.source_project_id !== undefined && mr.source_project_id !== mr.target_project_id };
}

export async function pollMerges(context: ServiceContext, options: { pull: boolean; includeDrafts: boolean; includeOwn: boolean }): Promise<PollResult> {
  const api = GitLabApi.from(context.credentials());
  const repo = repository(context);
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const [me, open] = await Promise.all([api.get<{ username: string }>("/user"), api.list<Summary>(`/projects/${projectId(repo)}/merge_requests?state=opened`)]);

  // Merged or closed since they were pulled: kept and marked, so reviews stay on record.
  const finished: PollResult["finished"] = [];
  if (options.pull && existsSync(folder(context))) {
    const openIds = new Set(open.map((mr) => mr.iid));
    for (const entry of await readdir(folder(context), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name) || openIds.has(Number(entry.name))) continue;
      const data = await frontMatter(path.join(folder(context), entry.name));
      if (!data || data.status === "merged" || data.status === "closed") continue;
      try {
        const mr = await api.get<Detail>(`/projects/${projectId(repo)}/merge_requests/${entry.name}`);
        if (mr.state === "opened") continue;
        const status = mr.state === "merged" ? "merged" : "closed";
        if (await updateFields(path.join(folder(context), entry.name, DESCRIPTION), { status })) {
          finished.push({ number: Number(entry.name), state: status });
          report.removed++;
        }
      } catch (error) {
        report.failed.push({ id: `!${entry.name}`, reason: (error as Error).message });
      }
    }
  }

  const considered: PollResult["considered"] = [];
  for (const mr of open) {
    if (!options.includeOwn && mr.author.username === me.username) continue;
    if (!options.includeDrafts && (mr.draft || mr.work_in_progress)) continue;
    const dir = path.join(folder(context), String(mr.iid));
    const data = await frontMatter(dir);
    const state: ReviewState = !data ? "new" : data.updated !== mr.updated_at ? "updated" : existsSync(path.join(dir, REVIEW)) ? "current" : "unreviewed";
    considered.push({ number: mr.iid, title: mr.title, author: mr.author.username, state });
  }

  if (options.pull) {
    for (const mr of considered.filter((m) => m.state === "new" || m.state === "updated")) {
      try {
        await pullMerge(context, api, repo, mr.number);
        if (mr.state === "new") report.added++;
        else report.updated++;
      } catch (error) {
        report.failed.push({ id: `!${mr.number}`, reason: (error as Error).message });
      }
    }
    indexMerges(context);
  }
  return { repo, open: open.length, considered, finished, report };
}

export async function waitingForReview(context: ServiceContext): Promise<Array<{ number: number; title: string; author: string }>> {
  if (!existsSync(folder(context))) return [];
  const waiting: Array<{ number: number; title: string; author: string }> = [];
  for (const entry of await readdir(folder(context), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const dir = path.join(folder(context), entry.name);
    const data = await frontMatter(dir);
    if (!data || data.status === "merged" || data.status === "closed" || existsSync(path.join(dir, REVIEW))) continue;
    waiting.push({ number: Number(entry.name), title: String(data.title ?? ""), author: String(data.author ?? "") });
  }
  return waiting.sort((a, b) => a.number - b.number);
}
