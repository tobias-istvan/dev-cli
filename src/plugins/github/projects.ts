import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Service, ServiceContext, SyncReport } from "../types.ts";
import { splitFrontMatter, updateFields, writeItem } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { DevError, describeError } from "../../core/output.ts";
import { choose, chooseMany } from "../../core/prompt.ts";
import { count, step, tally } from "../../core/progress.ts";
import { GitHubApi } from "./api.ts";

/**
 * GitHub Projects: boards as a task source. Each item on a board, whether an issue, a pull
 * request or a draft, becomes github-projects/<owner>-<number>/<item>/item.md, with the
 * board's own fields, like Status, Iteration or Priority. The scope is a list of boards, as
 * owner/number, and whether to keep every item or only yours.
 *
 * Projects are only reachable through GraphQL, and need the read:project scope.
 */

const SERVICE = "github:github-projects";
const ITEM = "item.md";
const DONE = /^(done|closed|complete(d)?|shipped|released|merged)$/i;

interface Field {
  name?: string;
  text?: string;
  date?: string;
  title?: string;
  number?: number;
  field?: { name?: string };
}

interface Content {
  __typename: "Issue" | "PullRequest" | "DraftIssue";
  number?: number;
  title: string;
  body?: string;
  url?: string;
  state?: string;
  repository?: { nameWithOwner: string };
  assignees?: { nodes: Array<{ login: string }> };
}

interface Item {
  id: string;
  updatedAt: string;
  fieldValues: { nodes: Field[] };
  content: Content | null;
}

interface Board {
  title: string;
  url: string;
  items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Item[] };
}

const BOARD_FIELDS = `
  title url
  items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id updatedAt
      fieldValues(first: 30) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
        }
      }
      content {
        __typename
        ... on Issue { number title body url state repository { nameWithOwner } assignees(first: 10) { nodes { login } } }
        ... on PullRequest { number title body url state repository { nameWithOwner } assignees(first: 10) { nodes { login } } }
        ... on DraftIssue { title body assignees(first: 10) { nodes { login } } }
      }
    }
  }`;

/** A board's items, whether it belongs to an organisation or a person. */
async function boardItems(api: GitHubApi, owner: string, number: number): Promise<{ title: string; url: string; items: Item[] }> {
  const items: Item[] = [];
  let after: string | null = null;
  let title = "";
  let url = "";
  for (let page = 0; page < 50; page++) {
    const data: { organization?: { projectV2: Board | null } | null; user?: { projectV2: Board | null } | null } = await api.graphql(
      `query($owner: String!, $number: Int!, $after: String) {
        organization(login: $owner) { projectV2(number: $number) { ${BOARD_FIELDS} } }
        user(login: $owner) { projectV2(number: $number) { ${BOARD_FIELDS} } }
      }`,
      { owner, number, after },
    );
    const board = data.organization?.projectV2 ?? data.user?.projectV2;
    if (!board) throw new DevError(`There's no GitHub project ${owner}/${number}, or the login can't see it.`, "Check the number in the board's URL, and that the login has read:project.");
    title = board.title;
    url = board.url;
    items.push(...board.items.nodes);
    if (!board.items.pageInfo.hasNextPage) return { title, url, items };
    if (!board.items.pageInfo.endCursor || board.items.pageInfo.endCursor === after) throw new DevError("GitHub Projects returned a repeated cursor.");
    after = board.items.pageInfo.endCursor;
  }
  throw new DevError("GitHub project exceeds the 5,000-item limit; narrow the scope.");
}

function boards(context: ServiceContext): Array<{ owner: string; number: number }> {
  return (Array.isArray(context.scope.projects) ? context.scope.projects.map(String) : [])
    .map((key) => key.match(/^([\w.-]+)\/(\d+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m?.[1] && m[2]))
    .map((m) => ({ owner: m[1] ?? "", number: Number(m[2]) }));
}

function folder(context: ServiceContext): string {
  return context.folder ?? path.join(context.root, "github-projects");
}

const repoDir = (repo: string, number: number) => `${repo.split("/").map((part) => encodeURIComponent(part).replace(/-/g, "%2D")).join("-")}-${number}`;

/** A stable name for an item: its issue or PR, or a short hash of a draft's id. */
function itemKey(item: Item): { id: string; dir: string } {
  const content = item.content;
  if (content?.repository && content.number) {
    return { id: `${content.repository.nameWithOwner}#${content.number}`, dir: repoDir(content.repository.nameWithOwner, content.number) };
  }
  const short = createHash("sha256").update(item.id).digest("hex").slice(0, 10);
  return { id: `draft-${short}`, dir: `draft-${short}` };
}

function fieldsOf(item: Item): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const value of item.fieldValues.nodes) {
    const name = value.field?.name;
    if (!name || name === "Title" || name === "Assignees" || name === "Repository") continue;
    const text = value.name ?? value.text ?? value.date ?? value.title ?? (value.number !== undefined ? String(value.number) : undefined);
    if (text) fields[name] = text;
  }
  return fields;
}

async function localItems(context: ServiceContext): Promise<Array<{ path: string; data: Record<string, unknown> }>> {
  const base = folder(context);
  if (!existsSync(base)) return [];
  const items: Array<{ path: string; data: Record<string, unknown> }> = [];
  for (const relative of (await readdir(base, { recursive: true, encoding: "utf8" })).filter((f) => path.basename(f) === ITEM)) {
    const { data } = splitFrontMatter(await readFile(path.join(base, relative), "utf8"));
    if (data) items.push({ path: await migrateDir(base, relative.split(path.sep).join("/"), data), data });
  }
  return items;
}

/**
 * Folders used to be named with plain hyphens, so owner/a-b#1 and owner-a/b#1 collided. An
 * item still in its old folder moves to its new one, notes and all, so nothing is duplicated.
 * Returns where the item is now.
 */
async function migrateDir(base: string, relative: string, data: Record<string, unknown>): Promise<string> {
  const [board, dir, ...rest] = relative.split("/");
  const match = String(data.id).match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!board || !dir || rest.length !== 1 || !match?.[1]) return relative;
  const current = repoDir(match[1], Number(match[2]));
  if (dir === current || dir !== `${match[1].replace("/", "-")}-${match[2]}` || existsSync(path.join(base, board, current))) return relative;
  await rename(path.join(base, board, dir), path.join(base, board, current));
  return `${board}/${current}/${ITEM}`;
}

async function sync(context: ServiceContext): Promise<SyncReport> {
  const api = GitHubApi.from(context.credentials());
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const me = (await api.get<{ login: string }>("/user")).login;
  const mineOnly = context.scope.assigned !== "any";
  const local = await localItems(context);
  const kept = new Set<string>();
  const failedBoards = new Set<string>();

  for (const { owner, number } of boards(context)) {
    const boardDir = `${owner}-${number}`;
    let board: { title: string; url: string; items: Item[] };
    try {
      context.progress(`reading board ${owner}/${number}`);
      board = await boardItems(api, owner, number);
    } catch (error) {
      failedBoards.add(`${owner}/${number}`);
      report.failed.push({ id: `${owner}/${number}`, reason: describeError(error) });
      continue;
    }
    const tick = tally(context.progress, board.items.length, "item", undefined, `${board.title}: `);
    for (const item of board.items) {
      tick();
      const content = item.content;
      if (!content) continue;
      const assignees = (content.assignees?.nodes ?? []).map((a) => a.login);
      const fields = fieldsOf(item);
      const status = fields.Status ?? (content.state ? content.state.toLowerCase() : "");
      const done = DONE.test(status) || content.state === "CLOSED" || content.state === "MERGED";
      if (mineOnly && !assignees.includes(me)) continue;
      const { id, dir } = itemKey(item);
      const relative = `${boardDir}/${dir}/${ITEM}`;
      kept.add(relative);
      const due = Object.entries(fields).find(([name]) => /due|deadline|target date|end date/i.test(name))?.[1] ?? "";
      try {
        const target = path.join(folder(context), boardDir, dir, ITEM);
        const result = await writeItem(
          target,
          {
            id,
            title: content.title,
            service: SERVICE,
            url: content.url ?? board.url,
            updated: item.updatedAt,
            synced: new Date().toISOString(),
            status,
            board: `${owner}/${number}`,
            type: content.__typename === "PullRequest" ? "pull request" : content.__typename === "DraftIssue" ? "draft" : "issue",
            fields,
            assignees,
            mine: assignees.includes(me),
            done,
            due: due.slice(0, 10),
            inScope: true,
            via: "scope",
          },
          await context.localize([
            `# ${content.title}`,
            "",
            `On the board [${board.title}](${board.url})${Object.keys(fields).length > 0 ? `: ${Object.entries(fields).map(([k, v]) => `**${k}:** ${v}`).join(" · ")}` : "."}`,
            "",
            content.__typename === "DraftIssue" ? "A draft on the board, not an issue yet." : `The ${content.__typename === "PullRequest" ? "pull request" : "issue"}: ${content.url}`,
            "",
            "## Description",
            "",
            (content.body ?? "").trim() || "_No description._",
          ].join("\n"), target),
        );
        if (result === "added") report.added++;
        else if (result === "updated") report.updated++;
      } catch (error) {
        report.failed.push({ id, reason: describeError(error) });
      }
    }
  }

  // Items that left the boards, or were reassigned, stay, marked.
  for (const item of local) {
    if (item.data.inScope === true && !failedBoards.has(String(item.data.board)) && !kept.has(item.path) && (await updateFields(path.join(folder(context), item.path), { inScope: false, via: "former" }))) report.removed++;
  }
  if (existsSync(folder(context))) buildIndex(folder(context), INDEX.title, INDEX.include);
  return report;
}

function boardFrom(text: string): string | null {
  const url = text.match(/github\.com\/(?:orgs|users)\/([\w.-]+)\/projects\/(\d+)/);
  if (url?.[1] && url[2]) return `${url[1]}/${url[2]}`;
  return /^[\w.-]+\/\d+$/.test(text) ? text : null;
}

const INDEX: NonNullable<Service["index"]> = { folder: "github-projects", title: "GitHub project items", include: (f) => path.posix.basename(f) === ITEM };

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type BoardSummary = { number: number; title: string; closed: boolean };

/** Every open board the login can see, its own and its organizations', following every page. */
async function allBoards(api: GitHubApi, report: (detail: string) => void = () => {}): Promise<Array<{ owner: string; number: number; title: string }>> {
  const boards: Array<{ owner: string; number: number; title: string }> = [];
  const owners: Array<{ login: string; kind: "user" | "organization" }> = [];
  report("listing your organizations");
  for (let after: string | null = null, more = true; more; ) {
    const data: { viewer: { login: string; organizations: Page<{ login: string }> } } = await api.graphql(
      "query($after: String) { viewer { login organizations(first: 100, after: $after) { nodes { login } pageInfo { hasNextPage endCursor } } } }",
      { after },
    );
    if (owners.length === 0) owners.push({ login: data.viewer.login, kind: "user" });
    owners.push(...data.viewer.organizations.nodes.map((o) => ({ login: o.login, kind: "organization" as const })));
    ({ hasNextPage: more, endCursor: after } = data.viewer.organizations.pageInfo);
  }
  for (const [i, owner] of owners.entries()) {
    report(`${owner.login} (${i + 1} of ${owners.length})${boards.length > 0 ? `, ${count(boards.length, "board")} so far` : ""}`);
    for (let after: string | null = null, more = true; more; ) {
      const data: Record<string, { projectsV2: Page<BoardSummary> } | null> = await api.graphql(
        `query($login: String!, $after: String) { owner: ${owner.kind}(login: $login) { projectsV2(first: 100, after: $after) { nodes { number title closed } pageInfo { hasNextPage endCursor } } } }`,
        { login: owner.login, after },
      );
      const page = data.owner?.projectsV2;
      if (!page) break;
      boards.push(...page.nodes.filter((b) => !b.closed).map((b) => ({ owner: owner.login, number: b.number, title: b.title })));
      ({ hasNextPage: more, endCursor: after } = page.pageInfo);
    }
  }
  return boards;
}

export const projects: Service = {
  id: "github-projects",
  title: "GitHub Projects",
  index: INDEX,
  description: "Project boards: their items and fields",
  role: "connected",

  scope: {
    describe(scope) {
      const list = Array.isArray(scope.projects) ? scope.projects.join(", ") : "no boards";
      return `${scope.assigned === "any" ? "every item" : "items assigned to you"} on ${list}`;
    },
    async choose(context) {
      const api = GitHubApi.from(context.credentials());
      const boards = await step(context.out, "Finding your project boards", (report) => allBoards(api, report), (found) => `Found ${count(found.length, "open board")}`);
      const options = boards.map((b) => ({ value: `${b.owner}/${b.number}`, name: b.title, description: `${b.owner}/${b.number}` }));
      if (options.length === 0) throw new DevError("The GitHub login can't see any project boards.", "Add one later with: dev github-projects scope add <board link>");
      const picked = await chooseMany("Which boards? Type to filter, Tab to pick, Enter when done.", options, "edit dev.yaml");
      const assigned = await choose("Which items should dev keep?", [{ value: "me", name: "Items assigned to me" }, { value: "any", name: "Every item" }], "edit dev.yaml");
      return { projects: picked, assigned };
    },
    validate(scope) {
      if (!Array.isArray(scope.projects) || scope.projects.length === 0 || !scope.projects.every((p) => /^[\w.-]+\/\d+$/.test(String(p)))) {
        return [{ message: '"projects" should list boards as owner/number, like [acme/3].' }];
      }
      if (scope.assigned !== undefined && scope.assigned !== "me" && scope.assigned !== "any") return [{ message: '"assigned" should be me or any.' }];
      return [];
    },
    add(scope, items) {
      const list = Array.isArray(scope.projects) ? scope.projects.map(String) : [];
      const added: string[] = [];
      const problems = [];
      for (const item of items) {
        const board = boardFrom(item);
        if (!board) problems.push({ message: `"${item}" isn't a board, like a project's link or owner/number.` });
        else if (!list.includes(board) && !added.includes(board)) added.push(board);
      }
      return { scope: { ...scope, projects: [...list, ...added] }, added, problems };
    },
    remove(scope, items) {
      const list = Array.isArray(scope.projects) ? scope.projects.map(String) : [];
      const removed = items.map((item) => boardFrom(item) ?? item).filter((b) => list.includes(b));
      return { scope: { ...scope, projects: list.filter((b) => !removed.includes(b)) }, removed, problems: [] };
    },
  },

  sync,

  tasks: {
    async list(context) {
      return (await localItems(context)).map((item) => ({
        id: String(item.data.id),
        title: String(item.data.title ?? ""),
        status: String(item.data.status ?? ""),
        done: item.data.done === true,
        mine: item.data.mine === true,
        inScope: item.data.inScope === true,
        via: typeof item.data.via === "string" ? item.data.via : "scope",
        ...(typeof item.data.due === "string" && item.data.due ? { due: item.data.due } : {}),
        ...(typeof item.data.synced === "string" ? { synced: item.data.synced } : {}),
        file: `github-projects/${item.path}`,
      }));
    },
  },

  contribute: {
    async snapshot(context) {
      const open = (await localItems(context)).filter((i) => i.data.inScope === true && i.data.done !== true);
      if (open.length === 0) return null;
      return [
        "## GitHub project items",
        "",
        ...open
          .sort((a, b) => Number(b.data.mine === true) - Number(a.data.mine === true))
          .map((i) => `- [${String(i.data.title)}](${encodeURI(`github-projects/${i.path}`)}) [${String(i.data.status)}] on ${String(i.data.board)}${i.data.mine === true ? " · mine" : ""}`),
      ].join("\n");
    },
  },

  agentFiles: {
    rules: ["Never move, edit or add items on a GitHub project board unless the person asks you to in this conversation."],
  },
};
