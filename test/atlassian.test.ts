/** Jira and Confluence against a fake Atlassian site, plus dev add, remove and scope. */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGIN = path.join(import.meta.dirname, "fixtures", "example-plugin.ts");
const exec = promisify(execFile);

let base: string;
let origin: string;
let server: Server;
let site: string;
const state = { searchKeys: ["ABC-1", "ABC-2"], failChild: false, updated: "2026-11-07T09:00:00.000+0000" };

function issue(key: string) {
  const parent = key === "ABC-1" ? { parent: { key: "ABC-9", fields: { summary: "The epic", issuetype: { name: "Story" } } } } : {};
  return {
    key,
    fields: {
      summary: key === "ABC-9" ? "The epic" : `Ticket ${key}`,
      status: { name: key === "ABC-1" ? "In Progress" : "To Do", statusCategory: { key: key === "ABC-1" ? "indeterminate" : "new" } },
      issuetype: { name: key === "ABC-2" ? "Bug" : "Story" },
      updated: state.updated,
      duedate: key === "ABC-1" ? "2026-01-01" : null,
      customfield_2: 5,
      comment: { comments: [{ id: "c1", author: { displayName: "Kim" }, created: "2026-11-06T10:00:00.000+0000" }] },
      ...parent,
    },
    renderedFields: {
      description: `<p>Build it. Spec: <a href="${site}/wiki/spaces/SP/pages/100/Spec">spec</a>. Uses UTF-8.</p>`,
      customfield_1: "<ul><li>It works</li></ul>",
      comment: { comments: [{ id: "c1", body: "<p>Looks <strong>fine</strong></p>" }] },
    },
  };
}

function page(id: string) {
  const child = id === "101";
  return {
    id,
    title: child ? "Child" : "Spec",
    spaceId: "S1",
    version: { number: 3, createdAt: "2026-11-05T08:00:00.000Z" },
    _links: { webui: `/spaces/SP/pages/${id}` },
    body: {
      storage: {
        value: child
          ? "<p>Child text</p>"
          : '<p>See <ac:link><ri:page ri:content-title="Child" /></ac:link>.</p><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>',
      },
    },
  };
}

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-atl-")));
  server = createServer((request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.headers.authorization !== `Basic ${Buffer.from("me@example.test:atl-token-123").toString("base64")}`) return json(401, {});
    const url = new URL(request.url ?? "/", "http://x");
    const p = url.pathname;

    if (p === "/rest/api/3/myself") return json(200, { emailAddress: "me@example.test" });
    if (p === "/rest/api/3/field") return json(200, [{ id: "customfield_1", name: "Acceptance Criteria" }, { id: "customfield_2", name: "Story Points" }]);
    if (p === "/rest/api/3/search/jql") {
      // Two pages, to check paging.
      const second = url.searchParams.get("nextPageToken") === "p2";
      const keys = second ? state.searchKeys.slice(1) : state.searchKeys.slice(0, 1);
      return json(200, { issues: keys.map((key) => ({ key, fields: { summary: "", updated: state.updated } })), ...(second || state.searchKeys.length < 2 ? {} : { nextPageToken: "p2" }) });
    }
    const issueMatch = p.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/);
    if (issueMatch?.[1]) return ["ABC-1", "ABC-2", "ABC-9"].includes(issueMatch[1]) ? json(200, issue(issueMatch[1])) : json(404, { errorMessages: ["Issue does not exist"] });

    if (p === "/wiki/api/v2/spaces/S1") return json(200, { id: "S1", key: "SP" });
    if (p === "/wiki/api/v2/spaces") return json(200, { results: url.searchParams.get("keys") === "SP" ? [{ id: "S1", key: "SP" }] : [] });
    if (p === "/wiki/api/v2/spaces/S1/pages") return json(200, { results: [{ id: "100", title: "Spec" }] });
    if (p === "/wiki/api/v2/pages/100/descendants") return json(200, { results: [{ id: "101", type: "page", title: "Child", parentId: "100", depth: 1 }] });
    if (p === "/wiki/api/v2/pages/101/descendants") return json(200, { results: [] });
    if (/^\/wiki\/api\/v2\/pages\/\d+\/attachments$/.test(p)) return json(200, { results: [] });
    const pageMatch = p.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/);
    if (pageMatch?.[1] === "101" && state.failChild) return json(400, { message: "Broken page" });
    if (pageMatch?.[1] && ["100", "101"].includes(pageMatch[1])) return json(200, page(pageMatch[1]));
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A code repository, for task start.
  const seed = path.join(base, "seed");
  mkdirSync(seed);
  const git = (...args: string[]) => spawnSync("git", args, { cwd: seed });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  writeFileSync(path.join(seed, "README.md"), "code\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "start");
  origin = path.join(base, "origin.git");
  spawnSync("git", ["clone", "--quiet", "--bare", seed, origin]);
});

after(() => {
  server.close();
  rmSync(base, { recursive: true, force: true });
});

async function dev(cwd: string, args: string[]) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(base, "config"),
        DEV_EXTRA_PLUGINS: PLUGIN,
        DEV_EXAMPLE_TOKEN: "good",
        DEV_ATLASSIAN_SITE: site,
        DEV_ATLASSIAN_EMAIL: "me@example.test",
        DEV_ATLASSIAN_TOKEN: "atl-token-123",
      },
      timeout: 60_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

async function workspace(services = true): Promise<string> {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  const init = await dev(root, ["init", "--versioning", "example:code", "--repo", "acme/web", "--clone-url", origin]);
  assert.equal(init.code, 0, init.err);
  if (services) {
    assert.equal((await dev(root, ["add", "jira", "--scope", "{ project: ABC, jql: assignee = currentUser() }"])).code, 0);
    assert.equal((await dev(root, ["add", "confluence", "--scope", "{ roots: [100] }"])).code, 0);
  }
  return root;
}

test("jira sync writes one file per ticket, leaves unchanged ones alone, and removes ones that left the scope", async () => {
  const root = await workspace();
  const first = await dev(root, ["sync", "jira"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /Jira: 2 new, 0 updated, 0 removed\./);

  const ticket = readFileSync(path.join(root, "jira", "ABC-1.md"), "utf8");
  assert.match(ticket, /^---\nid: ABC-1\ntitle: Ticket ABC-1\nservice: atlassian:jira\nurl: http:\/\/127\.0\.0\.1:\d+\/browse\/ABC-1\n/);
  assert.match(ticket, /status: In Progress\nparent: ABC-9\ntype: Story\n/);
  assert.match(ticket, /points: 5\n/);
  assert.match(ticket, /## Acceptance criteria\n\n-\s+It works/);
  assert.match(ticket, /### Kim · 2026-11-06 10:00\n\nLooks \*\*fine\*\*/);
  assert.match(readFileSync(path.join(root, "jira", "index.md"), "utf8"), /2 items\./);

  const again = await dev(root, ["sync", "jira"]);
  assert.match(again.out, /Jira: 0 new, 0 updated, 0 removed\./);
  assert.equal(readFileSync(path.join(root, "jira", "ABC-1.md"), "utf8"), ticket, "an unchanged ticket keeps its file byte for byte");

  assert.equal((await dev(root, ["jira", "pull", "ABC-9"])).code, 0);
  state.searchKeys = ["ABC-1"];
  try {
    const shrunk = await dev(root, ["sync", "jira"]);
    assert.match(shrunk.out, /Jira: 0 new, 0 updated, 1 removed\./);
    assert.ok(!existsSync(path.join(root, "jira", "ABC-2.md")));
    assert.ok(existsSync(path.join(root, "jira", "ABC-9.md")), "a ticket pulled on demand stays");
  } finally {
    state.searchKeys = ["ABC-1", "ABC-2"];
  }
  assert.match((await dev(root, ["jira", "pull", "nope"])).err, /isn't a ticket key/);
});

test("confluence sync mirrors the page tree with working links, and keeps the old copy when a page fails", async () => {
  const root = await workspace();
  const first = await dev(root, ["sync", "confluence"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /Confluence: 2 new, 0 updated, 0 removed\./);

  const spec = path.join(root, "confluence", "SP", "Spec-100", "index.md");
  const text = readFileSync(spec, "utf8");
  assert.match(text, /^---\nid: "100"\ntitle: Spec\nservice: atlassian:confluence\n/);
  assert.match(text, /See \[Child\]\(Child-101\/index\.md\)\./);
  assert.match(text, /\| A \| B \|/);
  assert.ok(existsSync(path.join(root, "confluence", "SP", "Spec-100", "Child-101", "index.md")));
  assert.match(readFileSync(path.join(root, "confluence", "index.md"), "utf8"), /2 items\./);

  assert.match((await dev(root, ["sync", "confluence"])).out, /Confluence: 0 new, 0 updated, 0 removed\./);
  assert.equal(readFileSync(spec, "utf8"), text, "an unchanged page keeps its file byte for byte");

  state.failChild = true;
  try {
    const broken = await dev(root, ["sync", "confluence"]);
    assert.equal(broken.code, 1);
    assert.match(broken.err, /1 page failed, so the previous copy was kept/);
    assert.ok(existsSync(path.join(root, "confluence", "SP", "Spec-100", "Child-101", "index.md")));
    assert.ok(!existsSync(path.join(root, "confluence", ".staging")), "no staging is left behind");
  } finally {
    state.failChild = false;
  }
});

test("task start on a ticket fetches it, its parent and its spec, but not lookalike keys", async () => {
  const root = await workspace();
  const { code, out, err } = await dev(root, ["task", "start", "ABC-1"]);
  assert.equal(code, 0, err);
  assert.match(out, /Jira: Ticket ABC-1/);
  assert.match(out, /on feature\/ABC-1-ticket-abc-1/);

  const brief = readFileSync(path.join(root, "tasks", "ABC-1", "brief.md"), "utf8");
  assert.match(brief, /\[ABC-1\.md\]\(\.\.\/\.\.\/jira\/ABC-1\.md\)/);
  assert.match(brief, /\[ABC-9\.md\]\(\.\.\/\.\.\/jira\/ABC-9\.md\)/, "the parent is linked");
  assert.match(brief, /\[index\.md\]\(\.\.\/\.\.\/confluence\/SP\/Spec-100\/index\.md\)/, "the spec is fetched and linked");
  assert.ok(!existsSync(path.join(root, "jira", "UTF-8.md")));
  assert.doesNotMatch(err, /UTF-8/);

  const bug = await dev(root, ["task", "start", "ABC-2"]);
  assert.match(bug.out, /on fix\/ABC-2-ticket-abc-2/);
});

test("the snapshot lists due and in-progress tickets", async () => {
  const root = await workspace();
  await dev(root, ["sync", "jira"]);
  await dev(root, ["day", "start", "--no-sync"]);
  const snapshot = readFileSync(path.join(root, "snapshot.md"), "utf8");
  assert.match(snapshot, /## Jira\n\n### Due today or overdue \(1\)\n\n- \[ABC-1\]\(jira\/ABC-1\.md\) \[In Progress\] Ticket ABC-1 · due 2026-01-01/);
  assert.match(snapshot, /### To do \(1\)\n\n- \[ABC-2\]/);
});

test("add, scope and remove change dev.yaml and the agent files", async () => {
  const root = await workspace(false);

  const bad = await dev(root, ["add", "jira", "--scope", "{ project: ABC }"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /needs a "jql" search/);

  assert.equal((await dev(root, ["add", "jira", "--scope", "{ jql: project = ABC }"])).code, 0);
  assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /`jira\/` \| Jira:/);
  assert.match((await dev(root, ["add", "jira"])).err, /already enabled/);

  assert.match((await dev(root, ["jira", "scope"])).out, /Jira syncs: project = ABC/);
  assert.equal((await dev(root, ["jira", "scope", "--set", "{ jql: project = XYZ }"])).code, 0);
  assert.match(readFileSync(path.join(root, "dev.yaml"), "utf8"), /jql: project = XYZ/);

  mkdirSync(path.join(root, "jira"), { recursive: true });
  const removed = await dev(root, ["remove", "jira"]);
  assert.match(removed.out, /Its folder jira\/ is still there/);
  assert.doesNotMatch(readFileSync(path.join(root, "dev.yaml"), "utf8"), /atlassian:jira/);
  assert.match((await dev(root, ["add", "nothing"])).err, /isn't a service dev can add/);
});

test("the Atlassian login check reports a rejected token", async () => {
  const root = await workspace(false);
  await dev(root, ["add", "jira", "--scope", "{ jql: x }"]);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_EXTRA_PLUGINS: PLUGIN, DEV_EXAMPLE_TOKEN: "good", DEV_ATLASSIAN_SITE: site, DEV_ATLASSIAN_EMAIL: "me@example.test", DEV_ATLASSIAN_TOKEN: "wrong" };
  const result = await exec(process.execPath, [CLI, "doctor"], { cwd: root, env }).catch((error) => error as { stdout: string });
  assert.match(result.stdout, /rejected the saved login\.\n {2}Fix: Run "dev login atlassian" again/);
});

test("a whole space can be in scope, alongside pages from other spaces", async () => {
  const root = await workspace(false);
  const bad = await dev(root, ["add", "confluence", "--scope", "{ spaces: [] }"]);
  assert.match(bad.err, /has no pages or spaces in it/);

  assert.equal((await dev(root, ["add", "confluence", "--scope", "{ spaces: [SP], roots: [101] }"])).code, 0);
  assert.match((await dev(root, ["confluence", "scope"])).out, /Confluence syncs: whole space SP and 1 page tree/);

  const synced = await dev(root, ["sync", "confluence"]);
  assert.equal(synced.code, 0, synced.err);
  assert.ok(existsSync(path.join(root, "confluence", "SP", "Spec-100", "Child-101", "index.md")), "the space's top-level page and its tree");
  assert.ok(existsSync(path.join(root, "confluence", "SP", "Child-101", "index.md")), "the separately listed page");

  assert.equal((await dev(root, ["confluence", "scope", "--set", "{ spaces: [NOPE] }"])).code, 0);
  const missing = await dev(root, ["sync", "confluence"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no Confluence space NOPE/);
});
