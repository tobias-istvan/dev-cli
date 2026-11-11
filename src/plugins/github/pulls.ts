import { reviewCurrent } from "../../core/reviews.ts";
import { atomicWrite } from "../../core/files.ts";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Service, ServiceContext, SyncReport } from "../types.ts";
import { splitFrontMatter, updateFields, writeItem } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { loadConfig } from "../../core/project-config.ts";
import { GitHubApi } from "./api.ts";
import { describeError } from "../../core/output.ts";

/**
 * Other people's pull requests, pulled into pull-requests/<N>/ for review.
 *
 * Each open PR is classified against what's on disk:
 *   new         no folder yet
 *   updated     changed since it was pulled, so any review is stale
 *   unreviewed  pulled and current, but no review.md
 *   current     pulled and reviewed at this version
 * Only PRs needing attention are fetched, so a quiet repository costs one request.
 */

export const FOLDER = "pull-requests";
export const DESCRIPTION = "pr-description.md";
export const REVIEW = "review.md";

export type ReviewState = "new" | "updated" | "unreviewed" | "current";

interface Summary {
  number: number;
  title: string;
  user: { login: string };
  draft: boolean;
  updated_at: string;
  html_url: string;
}

interface Detail extends Summary {
  body: string | null;
  state: "open" | "closed";
  merged_at: string | null;
  base: { ref: string };
  head: { ref: string; repo?: { full_name: string } | null };
  additions: number;
  deletions: number;
  changed_files: number;
}

interface Comment {
  user?: { login?: string };
  body?: string | null;
  created_at?: string;
  submitted_at?: string;
  path?: string;
  line?: number | null;
  state?: string;
}

export interface PollOptions {
  pull: boolean;
  includeDrafts: boolean;
  includeOwn: boolean;
}

export interface PollResult {
  repo: string;
  open: number;
  considered: Array<{ number: number; title: string; author: string; state: ReviewState }>;
  removed: Array<{ number: number; state: "merged" | "closed" }>;
  report: SyncReport;
}

function repository(context: ServiceContext): string {
  const repo = loadConfig(context.root).versioning?.repo;
  if (!repo) throw new Error("dev.yaml names no repository.");
  return repo;
}

function folder(context: ServiceContext): string {
  return path.join(context.root, FOLDER);
}

async function syncedVersion(dir: string): Promise<string | null> {
  try {
    const { data } = splitFrontMatter(await readFile(path.join(dir, DESCRIPTION), "utf8"));
    return typeof data?.updated === "string" ? data.updated : null;
  } catch {
    return null;
  }
}

async function syncedStatus(dir: string): Promise<string | null> {
  try {
    const { data } = splitFrontMatter(await readFile(path.join(dir, DESCRIPTION), "utf8"));
    return typeof data?.status === "string" ? data.status : null;
  } catch {
    return null;
  }
}

async function classify(context: ServiceContext, pr: Summary): Promise<ReviewState> {
  const dir = path.join(folder(context), String(pr.number));
  const synced = await syncedVersion(dir);
  if (synced === null) return "new";
  if (synced !== pr.updated_at) return "updated";
  return reviewCurrent(context.root, `pr-${pr.number}`, path.join(dir, REVIEW), synced) ? "current" : "unreviewed";
}

function when(comment: Comment): string {
  return comment.created_at ?? comment.submitted_at ?? "";
}

function renderComments(number: number, comments: Comment[], reviews: Comment[], inline: Comment[]): string {
  const entries = [
    ...comments.map((c) => ({ kind: "comment", c })),
    // A review with no body is only an approval marker; its inline comments are listed anyway.
    ...reviews.filter((c) => (c.body ?? "").trim()).map((c) => ({ kind: "review", c })),
    ...inline.map((c) => ({ kind: "inline", c })),
  ].sort((a, b) => when(a.c).localeCompare(when(b.c)));

  const body =
    entries.length === 0
      ? "_No comments._"
      : entries
          .map(({ kind, c }) => {
            const at = when(c).slice(0, 16).replace("T", " ");
            const where = c.path ? ` · \`${c.path}${c.line ? `:${c.line}` : ""}\`` : "";
            const state = kind === "review" && c.state ? ` (${c.state.toLowerCase()})` : "";
            return `### ${c.user?.login ?? "unknown"} · ${at} · ${kind === "inline" ? "inline comment" : kind}${state}${where}\n\n${(c.body ?? "").trim() || "_(empty)_"}`;
          })
          .join("\n\n");
  return `# PR #${number}: comments\n\n${body}\n`;
}

/** Pulls one PR. review.md is the reviewer's, and is never touched. */
export async function pullRequest(context: ServiceContext, api: GitHubApi, repo: string, number: number): Promise<{ comments: number; links: string[]; head: string; fork: boolean }> {
  const base = `/repos/${repo}`;
  const [pr, files, comments, reviews, inline] = await Promise.all([
    api.get<Detail>(`${base}/pulls/${number}`),
    api.listUpTo<{ filename: string; additions: number; deletions: number }>(`${base}/pulls/${number}/files`, 3000),
    api.list<Comment>(`${base}/issues/${number}/comments`),
    api.list<Comment>(`${base}/pulls/${number}/reviews`),
    api.list<Comment>(`${base}/pulls/${number}/comments`),
  ]);

  // A ticket key or link in the title or body is fetched from its service, if enabled.
  const references = await context.references(`${pr.title}\n${pr.body ?? ""}`);
  const links = references.map((r) => r.file ?? r.reference.url ?? r.reference.id);
  const linkLines = references.map((r) =>
    r.file
      ? `- ${r.reference.id}: [${r.file.split(path.sep).join("/")}](${path.posix.relative(`${FOLDER}/${number}`, r.file.split(path.sep).join("/"))})`
      : `- ${r.reference.url ?? r.reference.id} (${r.outside ? `outside the scope, not fetched${r.command ? `. To fetch it: \`${r.command}\`` : ""}` : "not fetched"})`,
  );

  const fields = {
      id: String(number),
      title: pr.title,
      service: "github:github",
      url: pr.html_url,
      updated: pr.updated_at,
      synced: new Date().toISOString(),
      status: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
      links,
      author: pr.user.login,
      base: pr.base.ref,
      head: pr.head.ref,
  };
  const body = [
      `# PR #${number}: ${pr.title}`,
      "",
      `${pr.user.login} · \`${pr.head.ref}\` into \`${pr.base.ref}\` · [on GitHub](${pr.html_url})`,
      "",
      `${pr.changed_files} file${pr.changed_files === 1 ? "" : "s"}, +${pr.additions} −${pr.deletions}`,
      "",
      "## Linked items",
      "",
      linkLines.length > 0 ? linkLines.join("\n") : "_None found in the title or description._",
      "",
      "## Description",
      "",
      (pr.body ?? "").trim() || "_No description._",
      "",
      "## Changed files",
      "",
      ...files.items.map((f) => `- \`${f.filename}\` +${f.additions} −${f.deletions}`),
      ...(files.items.length < pr.changed_files ? ["", `_Only ${files.items.length} of ${pr.changed_files} files are listed; the diff has the rest._`] : []),
      "",
      "Read the diff with `gh pr diff " + number + "`. Write your review in review.md in this folder.",
  ].join("\n");

  const dir = path.join(folder(context), String(number));
  await mkdir(dir, { recursive: true });
  const previous = await syncedVersion(dir);
  if (previous) reviewCurrent(context.root, `pr-${number}`, path.join(dir, REVIEW), previous);
  await writeItem(path.join(dir, DESCRIPTION), fields, body);
  await atomicWrite(path.join(dir, "comments.md"), renderComments(number, comments, reviews, inline));
  return {
    comments: comments.length + reviews.filter((r) => (r.body ?? "").trim()).length + inline.length,
    links,
    head: pr.head.ref,
    fork: Boolean(pr.head.repo && pr.head.repo.full_name !== repo),
  };
}

export const INDEX: NonNullable<Service["index"]> = { folder: FOLDER, title: "Pull requests under review", include: (file) => path.posix.basename(file) === DESCRIPTION };

export function indexPulls(context: ServiceContext): void {
  const dir = folder(context);
  if (existsSync(dir)) buildIndex(dir, INDEX.title, INDEX.include);
}

/** Finds the PRs that need review and, unless told not to, pulls them. */
export async function poll(context: ServiceContext, options: PollOptions): Promise<PollResult> {
  const api = GitHubApi.from(context.credentials());
  const repo = repository(context);
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };

  const [me, open] = await Promise.all([api.get<{ login: string }>("/user"), api.list<Summary>(`/repos/${repo}/pulls?state=open`)]);

  // PRs merged or closed since they were pulled keep their folder, marked, so reviews stay on record.
  const removed: PollResult["removed"] = [];
  if (options.pull && existsSync(folder(context))) {
    const openNumbers = new Set(open.map((pr) => pr.number));
    for (const entry of await readdir(folder(context), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name) || openNumbers.has(Number(entry.name))) continue;
      const known = await syncedStatus(path.join(folder(context), entry.name));
      if (known === "merged" || known === "closed") continue;
      try {
        const pr = await api.get<Detail>(`/repos/${repo}/pulls/${entry.name}`);
        if (pr.state !== "closed") continue;
        const status = pr.merged_at ? "merged" : "closed";
        const file = path.join(folder(context), entry.name, DESCRIPTION);
        if (!existsSync(file) || !(await updateFields(file, { status }))) continue;
        removed.push({ number: Number(entry.name), state: status });
        report.removed++;
      } catch (error) {
        report.failed.push({ id: `#${entry.name}`, reason: describeError(error) });
      }
    }
  }

  const candidates = open.filter((pr) => (options.includeOwn || pr.user.login !== me.login) && (options.includeDrafts || !pr.draft));
  const considered: PollResult["considered"] = [];
  for (const pr of candidates) {
    considered.push({ number: pr.number, title: pr.title, author: pr.user.login, state: await classify(context, pr) });
  }

  if (options.pull) {
    for (const pr of considered.filter((p) => p.state === "new" || p.state === "updated")) {
      try {
        await pullRequest(context, api, repo, pr.number);
        if (pr.state === "new") report.added++;
        else report.updated++;
      } catch (error) {
        report.failed.push({ id: `#${pr.number}`, reason: describeError(error) });
      }
    }
    indexPulls(context);
  }

  return { repo, open: open.length, considered, removed, report };
}

/** The PRs on disk that need review, from local files only, for the snapshot and session start. */
export async function waitingForReview(context: ServiceContext): Promise<Array<{ number: number; title: string; author: string; reviewed: boolean }>> {
  const dir = folder(context);
  if (!existsSync(dir)) return [];
  const items: Array<{ number: number; title: string; author: string; reviewed: boolean }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const { data } = splitFrontMatter(await readFile(path.join(dir, entry.name, DESCRIPTION), "utf8"));
      if (!data || data.status === "merged" || data.status === "closed") continue;
      items.push({
        number: Number(entry.name),
        title: String(data.title ?? ""),
        author: String(data.author ?? ""),
        reviewed: reviewCurrent(context.root, `pr-${entry.name}`, path.join(dir, entry.name, REVIEW), String(data.updated)),
      });
    } catch {
      // A half-written folder: the next poll repairs it.
    }
  }
  return items.sort((a, b) => a.number - b.number);
}
