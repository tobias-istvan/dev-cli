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
const state = { searchKeys: ["ABC-1", "ABC-2"], failChild: false, updated: "2026-11-07T09:00:00.000+0000", version: 3, childText: "Child text", crossParent: false };

function issue(key: string) {
  const parent = key === "ABC-1" ? { parent: { key: "ABC-9", fields: { summary: "The epic", issuetype: { name: "Story" } } } } : key === "ABC-2" && state.crossParent ? { parent: { key: "XYZ-8", fields: { summary: "Their epic", issuetype: { name: "Story" } } } } : {};
  return {
    key,
    fields: {
      summary: key === "ABC-9" ? "The epic" : `Ticket ${key}`,
      status: { name: key === "ABC-1" ? "In Progress" : "To Do", statusCategory: { key: key === "ABC-1" ? "indeterminate" : "new" } },
      issuetype: { name: key === "ABC-2" ? "Bug" : "Story" },
      updated: state.updated,
      assignee: key === "ABC-1" ? { displayName: "Me", accountId: "acc-me" } : { displayName: "Sam", accountId: "acc-sam" },
      duedate: key === "ABC-1" ? "2026-01-01" : null,
      customfield_2: 5,
      comment: { comments: [{ id: "c1", author: { displayName: "Kim" }, created: "2026-11-06T10:00:00.000+0000" }] },
      ...(key === "ABC-1" ? { attachment: [{ id: "55", filename: "diagram.png", size: 2048, content: `${site}/rest/api/3/attachment/content/55` }] } : {}),
      ...parent,
    },
    renderedFields: {
      description:
        key === "ABC-2"
          ? `<p>See <a href="${site}/wiki/spaces/OT/pages/300/Other">another team's page</a>, <a href="${site}/wiki/spaces/SP/pages/101/Child">the child page</a> and <a href="${site}/browse/XYZ-7">their ticket</a>.</p>`
          : `<p>Build it. Spec: <a href="${site}/wiki/spaces/SP/pages/100/Spec">spec</a>. Uses UTF-8.</p>${key === "ABC-1" ? '<p><img src="/rest/api/3/attachment/thumbnail/55"></p>' : ""}`,
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
    version: { number: state.version, createdAt: "2026-11-05T08:00:00.000Z" },
    _links: { webui: `/spaces/SP/pages/${id}` },
    body: {
      storage: {
        value: child
          ? `<p>${state.childText}</p>`
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

    if (p === "/rest/api/3/myself") return json(200, { emailAddress: "me@example.test", accountId: "acc-me" });
    if (p === "/rest/api/3/field") return json(200, [{ id: "customfield_1", name: "Acceptance Criteria" }, { id: "customfield_2", name: "Story Points" }]);
    if (p === "/rest/api/3/search/jql") {
      // Two pages, to check paging.
      const second = url.searchParams.get("nextPageToken") === "p2";
      const keys = second ? state.searchKeys.slice(1) : state.searchKeys.slice(0, 1);
      return json(200, { issues: keys.map((key) => ({ key, fields: { summary: "", updated: state.updated } })), ...(second || state.searchKeys.length < 2 ? {} : { nextPageToken: "p2" }) });
    }
    // Jira sends downloads on to its media store.
    if (p === "/rest/api/3/attachment/content/55") return response.writeHead(303, { location: "/media/55" }).end();
    if (p === "/media/55") return response.writeHead(200).end("png-bytes");
    const issueMatch = p.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/);
    if (issueMatch?.[1]) return ["ABC-1", "ABC-2", "ABC-3", "ABC-9", "XYZ-8"].includes(issueMatch[1]) ? json(200, issue(issueMatch[1])) : json(404, { errorMessages: ["Issue does not exist"] });

    if (p === "/wiki/api/v2/spaces/S1") return json(200, { id: "S1", key: "SP" });
    if (p === "/wiki/api/v2/spaces/S2") return json(200, { id: "S2", key: "OT" });
    if (p === "/wiki/api/v2/pages/101/ancestors") return json(200, { results: [{ id: "100" }] });
    if (p === "/wiki/api/v2/pages/300/ancestors") return json(200, { results: [] });
    if (p === "/wiki/api/v2/pages/300/descendants") return json(200, { results: [] });
    if (p === "/wiki/api/v2/pages/300") return json(200, { ...page("300"), id: "300", title: "Other", spaceId: "S2" });
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
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
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

test("jira sync writes one file per ticket, leaves unchanged ones alone, and marks ones that left the scope", async () => {
  const root = await workspace();
  const first = await dev(root, ["sync", "jira"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /Jira: 3 new, 0 updated, 0 removed\./, "two in scope, and the open one's parent");
  assert.match(readFileSync(path.join(root, "jira", "ABC-9", "ticket.md"), "utf8"), /inScope: false/);

  const ticket = readFileSync(path.join(root, "jira", "ABC-1", "ticket.md"), "utf8");
  assert.match(ticket, /^---\nid: ABC-1\ntitle: Ticket ABC-1\nservice: atlassian:jira\nurl: http:\/\/127\.0\.0\.1:\d+\/browse\/ABC-1\n/);
  assert.match(ticket, /status: In Progress\nparent: ABC-9\ntype: Story\n/);
  assert.match(ticket, /points: 5\n/);
  assert.match(ticket, /## Acceptance criteria\n\n-\s+It works/);
  assert.match(ticket, /### Kim · 2026-11-06 10:00\n\nLooks \*\*fine\*\*/);
  assert.match(readFileSync(path.join(root, "jira", "index.md"), "utf8"), /3 items\./);
  writeFileSync(path.join(root, "jira", "ABC-1", "research.md"), "my notes\n");

  const again = await dev(root, ["sync", "jira"]);
  assert.match(again.out, /Jira: 0 new, 0 updated, 0 removed\./);
  assert.equal(readFileSync(path.join(root, "jira", "ABC-1", "ticket.md"), "utf8"), ticket, "an unchanged ticket keeps its file byte for byte");
  assert.equal(readFileSync(path.join(root, "jira", "ABC-1", "research.md"), "utf8"), "my notes\n", "other files in the folder are never touched");

  assert.equal((await dev(root, ["jira", "pull", "ABC-9"])).code, 0);
  state.searchKeys = ["ABC-1"];
  try {
    const shrunk = await dev(root, ["sync", "jira"]);
    assert.match(shrunk.out, /Jira: 0 new, 1 updated, 0 removed\./);
    assert.match(readFileSync(path.join(root, "jira", "ABC-2", "ticket.md"), "utf8"), /inScope: false/, "it stays, marked as outside the scope");
    assert.ok(existsSync(path.join(root, "jira", "ABC-9", "ticket.md")), "a ticket pulled on demand stays");
  } finally {
    state.searchKeys = ["ABC-1", "ABC-2"];
  }
  assert.match((await dev(root, ["jira", "pull", "nope"])).err, /isn't a ticket key/);
});

test("the reference sweep rebuilds each index the same way the service's own sync does", async () => {
  const root = await workspace();
  assert.equal((await dev(root, ["sync", "jira"])).code, 0);
  mkdirSync(path.join(root, "jira", "ABC-1"), { recursive: true });
  writeFileSync(path.join(root, "jira", "ABC-1", "notes.md"), "---\nid: NOTE-1\ntitle: My notes\n---\n");
  assert.equal((await dev(root, ["sync", "jira"])).code, 0);
  const own = readFileSync(path.join(root, "jira", "index.md"), "utf8");
  assert.match(own, /^# Jira tickets\n/);
  assert.doesNotMatch(own, /NOTE-1/, "only ticket.md files are rows");

  const all = await dev(root, ["sync"]);
  assert.equal(all.code, 0, all.err);
  assert.equal(readFileSync(path.join(root, "jira", "index.md"), "utf8"), own, "a full sync's sweep writes the same index");
  assert.equal((await dev(root, ["index", "jira"])).code, 0);
  assert.equal(readFileSync(path.join(root, "jira", "index.md"), "utf8"), own, "dev index writes the same index");
});

test("a JQL-only scope reaches the projects its tickets are in, and keeps parents, links and pulls as they are", async () => {
  const root = await workspace(false);
  assert.equal((await dev(root, ["add", "jira", "--scope", "{ jql: assignee = currentUser() }"])).code, 0);
  const early = await dev(root, ["jira", "pull", "ABC-9"]);
  assert.notEqual(early.code, 0);
  assert.match(early.err, /dev sync jira" first/, "before any sync, the boundary is unknown and says how to fix that");

  state.crossParent = true;
  try {
    const first = await dev(root, ["sync", "jira"]);
    assert.equal(first.code, 0, first.err);
    assert.match(readFileSync(path.join(root, "jira", "ABC-9", "ticket.md"), "utf8"), /via: parent/, "a same-project parent is kept");
    assert.ok(!existsSync(path.join(root, "jira", "XYZ-8")), "a parent in another project isn't fetched");

    assert.equal((await dev(root, ["jira", "pull", "ABC-9"])).code, 0);
    assert.match((await dev(root, ["jira", "pull", "XYZ-8"])).err, /outside this workspace's scope/);
    // Links between tickets come from other services' items; one fetched earlier looks like this.
    assert.equal((await dev(root, ["jira", "pull", "ABC-3"])).code, 0);
    const linked = path.join(root, "jira", "ABC-3", "ticket.md");
    writeFileSync(linked, readFileSync(linked, "utf8").replace("via: pulled", "via: linked"));

    for (let run = 0; run < 2; run++) {
      const again = await dev(root, ["sync", "jira"]);
      assert.equal(again.code, 0, again.err);
      assert.match(again.out, /0 removed/);
      assert.match(readFileSync(path.join(root, "jira", "ABC-3", "ticket.md"), "utf8"), /inScope: false[\s\S]*via: linked|via: linked[\s\S]*inScope: false/, "a linked ticket stays linked");
      assert.doesNotMatch(readFileSync(path.join(root, "jira", "ABC-9", "ticket.md"), "utf8"), /via: former/);
    }
  } finally {
    state.crossParent = false;
  }
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
  assert.match(brief, /\[jira\/ABC-1\/ticket\.md\]\(\.\.\/\.\.\/jira\/ABC-1\/ticket\.md\)/);
  assert.match(brief, /\[jira\/ABC-9\/ticket\.md\]\(\.\.\/\.\.\/jira\/ABC-9\/ticket\.md\)/, "the parent is linked");
  assert.match(brief, /\]\(\.\.\/\.\.\/confluence\/SP\/Spec-100\/index\.md\)/, "the spec is fetched and linked");
  assert.ok(!existsSync(path.join(root, "jira", "UTF-8")));
  assert.doesNotMatch(err, /UTF-8/);

  const bug = await dev(root, ["task", "start", "ABC-2"]);
  assert.match(bug.out, /on fix\/ABC-2-ticket-abc-2/);
});

test("the snapshot lists due and in-progress tickets", async () => {
  const root = await workspace();
  await dev(root, ["sync", "jira"]);
  await dev(root, ["day", "start", "--no-sync"]);
  const snapshot = readFileSync(path.join(root, "snapshot.md"), "utf8");
  assert.match(snapshot, /## Jira\n\n### Due today or overdue \(1\)\n\n- \[ABC-1\]\(jira\/ABC-1\/ticket\.md\) \[In Progress\] Ticket ABC-1 · due 2026-01-01/);
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

test("only items within the scope are fetched, and the rest are listed with their links", async () => {
  const root = await workspace();
  await dev(root, ["sync"]);
  const brief = await dev(root, ["task", "start", "ABC-2"]);
  assert.equal(brief.code, 0, brief.err);
  const text = readFileSync(path.join(root, "tasks", "ABC-2", "brief.md"), "utf8");
  assert.match(text, /Child-101\/index\.md/, "a page under a root in scope is linked");
  assert.match(text, /Outside this workspace's scope, so not fetched[^]*\/wiki\/spaces\/OT\/pages\/300\/Other/);
  assert.ok(!existsSync(path.join(root, "confluence", "OT")), "the other team's page wasn't fetched");

  const pulled = await dev(root, ["confluence", "pull", "300"]);
  assert.equal(pulled.code, 1);
  assert.match(pulled.err, /outside this workspace's scope[^]*fetch: anywhere/);

  writeFileSync(path.join(root, "dev.yaml"), readFileSync(path.join(root, "dev.yaml"), "utf8").replace(/(- service: atlassian:confluence\n)/, "$1    fetch: anywhere\n"));
  assert.equal((await dev(root, ["confluence", "pull", "300"])).code, 0);
  assert.ok(existsSync(path.join(root, "confluence", "OT", "Other-300", "index.md")));
});

test("--referenced keeps docs that tasks point to up to date, without pulling whole trees", async () => {
  const root = await workspace();
  const first = await dev(root, ["sync", "--referenced"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /Jira: 3 new/, "task sources still sync in full");
  assert.match(first.out, /Confluence \(referenced only\): 0 new, 0 updated/);
  assert.match(first.out, /Confluence: 2 new from references\./);
  assert.match(first.out, /Confluence: 1 linked item is outside the scope, so not fetched:\n {2}http:\/\/[^\n]*\/wiki\/spaces\/OT\/pages\/300\/Other\n {4}linked from ABC-2\n {4}to fetch it: dev confluence scope add http:\/\/[^\n]*\/wiki\/spaces\/OT\/pages\/300\/Other\n {2}Then run "dev sync confluence"\./);
  assert.match(first.out, /to fetch it: dev jira scope add http:\/\/[^\n]*\/browse\/XYZ-7/);
  assert.doesNotMatch(first.out, /UTF-8/, "a lookalike key is never reported as outside the scope");

  // Links to what's in the workspace are local, with the address kept; the rest say how to fetch them.
  const linking = readFileSync(path.join(root, "jira", "ABC-2", "ticket.md"), "utf8");
  assert.match(linking, /\[the child page\]\(\.\.\/\.\.\/confluence\/SP\/Child-101\/index\.md "http:\/\/[^"]*\/wiki\/spaces\/SP\/pages\/101\/Child"\)/);
  assert.match(linking, /\[another team's page\]\(http:\/\/[^)]*\/pages\/300\/Other\)/);
  assert.match(linking, /## Outside the scope[^]*- `dev confluence scope add http:\/\/[^`]*\/pages\/300\/Other`\n- `dev jira scope add http:\/\/[^`]*\/browse\/XYZ-7`/);
  assert.match(readFileSync(path.join(root, "jira", "ABC-1", "ticket.md"), "utf8"), /\[ABC-9\]\(\.\.\/ABC-9\/ticket\.md "http:\/\/[^"]*\/browse\/ABC-9"\)/);

  // Attachments sit next to the ticket, and the text points at them.
  const withImage = readFileSync(path.join(root, "jira", "ABC-1", "ticket.md"), "utf8");
  const image = withImage.match(/!\[\]\((attachments\/diagram-[0-9a-f]{12}\.png)\)/)?.[1];
  assert.ok(image, withImage);
  assert.equal(readFileSync(path.join(root, "jira", "ABC-1", image), "utf8"), "png-bytes");
  assert.match(withImage, /## Attachments\n\n- \[diagram\.png\]\(attachments\/diagram-[0-9a-f]{12}\.png\) \(2 KB\)/);
  assert.match(withImage, /attachments: 1/);

  const again = await dev(root, ["sync", "--referenced"]);
  assert.match(again.out, /Jira: 0 new, 0 updated/, "local links are stable from one sync to the next");
  assert.equal(readFileSync(path.join(root, "jira", "ABC-2", "ticket.md"), "utf8"), linking);
  assert.ok(existsSync(path.join(root, "confluence", "SP", "Spec-100", "index.md")), "the spec ABC-1 points to");
  assert.ok(existsSync(path.join(root, "confluence", "SP", "Child-101", "index.md")), "the page ABC-2 points to");
  assert.ok(!existsSync(path.join(root, "confluence", "SP", "Spec-100", "Child-101")), "no whole tree");

  state.version = 4;
  state.childText = "Changed text";
  try {
    const second = await dev(root, ["sync", "confluence", "--referenced"]);
    assert.match(second.out, /Confluence \(referenced only\): 0 new, 2 updated/);
    assert.match(readFileSync(path.join(root, "confluence", "SP", "Child-101", "index.md"), "utf8"), /Changed text/);
  } finally {
    state.version = 3;
    state.childText = "Child text";
  }

  writeFileSync(path.join(root, "dev.yaml"), readFileSync(path.join(root, "dev.yaml"), "utf8").replace(/(- service: atlassian:confluence\n)/, "$1    sync: referenced\n"));
  assert.match((await dev(root, ["sync", "confluence"])).out, /Confluence \(referenced only\)/, "dev.yaml can make it the default");
});

test("jira lists its tasks, marking the ones assigned to you", async () => {
  const root = await workspace();
  await dev(root, ["sync", "jira"]);
  assert.match(readFileSync(path.join(root, "jira", "ABC-1", "ticket.md"), "utf8"), /mine: true/);
  assert.match(readFileSync(path.join(root, "jira", "ABC-2", "ticket.md"), "utf8"), /mine: false/);
});

test("tickets in the earlier flat layout move into their folders", async () => {
  const root = await workspace();
  mkdirSync(path.join(root, "jira"), { recursive: true });
  writeFileSync(path.join(root, "jira", "ABC-1.md"), "---\nid: ABC-1\ntitle: Old\nservice: atlassian:jira\nurl: u\nupdated: x\nsynced: y\ninScope: true\n---\n\nOld\n");
  await dev(root, ["sync", "jira"]);
  assert.ok(!existsSync(path.join(root, "jira", "ABC-1.md")));
  assert.match(readFileSync(path.join(root, "jira", "ABC-1", "ticket.md"), "utf8"), /title: Ticket ABC-1/);
});

test("Confluence short links are recognised by their page id", async () => {
  const { shortLinkId, confluence } = await import("../src/plugins/atlassian/confluence.ts");
  assert.equal(shortLinkId("DoBcSg"), "1247576078");
  assert.equal(shortLinkId("MIQrSg"), "1244365872");
  assert.equal(shortLinkId("not a code!"), null);
  const found = confluence.links?.find("See https://x.atlassian.net/wiki/x/MIQrSg and https://x.atlassian.net/wiki/spaces/A/pages/1244365872/Same", {} as never);
  assert.deepEqual(found?.map((r) => r.id), ["1244365872"], "the same page once");
});

test("the sweep reads every open ticket, not only those in scope", async () => {
  const root = await workspace();
  await dev(root, ["sync", "jira"]);
  // ABC-9 is outside the scope, open, and links the spec. ABC-1 no longer does.
  writeFileSync(path.join(root, "jira", "ABC-1", "ticket.md"), readFileSync(path.join(root, "jira", "ABC-1", "ticket.md"), "utf8").replace(/\[spec\]\([^)]*\)/, "spec"));
  rmSync(path.join(root, "confluence"), { recursive: true, force: true });
  const result = await dev(root, ["sync", "confluence", "--referenced"]);
  assert.match(result.out, /Confluence: \d+ new from references/);
  assert.ok(existsSync(path.join(root, "confluence", "SP", "Spec-100", "index.md")));
});

test("scope add and remove change a Confluence scope by link or id", async () => {
  const root = await workspace();
  const added = await dev(root, ["confluence", "scope", "add", `${site}/wiki/spaces/OT/pages/300/Other`, `${site}/wiki/x/MIQrSg`, "nonsense"]);
  assert.equal(added.code, 1, "one item was wrong");
  assert.match(added.err, /"nonsense" isn't a Confluence page link or id/);
  assert.match(added.out, /Done: added 300, 1244365872\. Confluence now syncs 3 page trees/);

  assert.match((await dev(root, ["confluence", "scope", "add", "300"])).out, /Nothing changed/);
  assert.match((await dev(root, ["confluence", "scope", "remove", "300", "1244365872"])).out, /Done: removed 300, 1244365872/);
  assert.match((await dev(root, ["confluence", "scope", "rename"])).err, /isn't something scope can do/);
  assert.match((await dev(root, ["jira", "scope", "add", `${site}/browse/XYZ-7`])).out, /Done: added XYZ\. Jira now syncs .*, and tickets linked from there in XYZ/);
});

test("indexes say which items are yours and why each is here, and task list answers what's yours", async () => {
  const root = await workspace();
  await dev(root, ["sync"]);

  const index = readFileSync(path.join(root, "jira", "index.md"), "utf8");
  assert.match(index, /\| ID \| Title \| Status \| Mine \| Why \| Updated \|/);
  assert.match(index, /\| \[ABC-1\]\(ABC-1\/ticket\.md\) \| Ticket ABC-1 \| In Progress \| yes \| scope \|/);
  assert.match(index, /\| \[ABC-9\]\(ABC-9\/ticket\.md\) \| The epic \| To Do \|  \| parent \|/);
  const pages = readFileSync(path.join(root, "confluence", "index.md"), "utf8");
  assert.match(pages, /\| ID \| Title \| Status \| Why \| Updated \|/, "no Mine column where there's no assignee");

  const open = await dev(root, ["task", "list"]);
  assert.equal(open.code, 0, open.err);
  assert.match(open.out, /^Jira, as of .*: 2 tasks\n {2}ABC-1 {2}\[In Progress\] {2}Ticket ABC-1 {2}· due 2026-01-01, overdue · mine {2}\(jira\/ABC-1\/ticket\.md\)\n {2}ABC-2 /);
  assert.doesNotMatch(open.out, /ABC-9/, "context isn't listed as work");
  assert.match(open.out, /From the last sync\. Add --refresh to sync first\./);

  const mine = await dev(root, ["task", "list", "--mine"]);
  assert.match(mine.out, /1 task\n {2}ABC-1 /);
  assert.doesNotMatch(mine.out, /ABC-2/);

  assert.match((await dev(root, ["task", "list", "--all"])).out, /ABC-9 {2}\[To Do\] {2}The epic {2}· parent/);
  const json = JSON.parse((await dev(root, ["task", "list", "--json"])).out);
  assert.deepEqual(json[0].tasks.map((t: { id: string }) => t.id), ["ABC-1", "ABC-2"]);
});
