import { taskId } from "../src/core/tasks.ts";
/** GitHub Issues as a second task source, against a fake GitHub API. */
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
const TOKEN = "ghp_fake";
const exec = promisify(execFile);

let base: string;
let origin: string;
let server: Server;
let apiUrl: string;
const state = { closed: [] as number[], lookups: 0 };

const issue = (number: number, title: string, assignee: string | null, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  body: number === 5 ? "Fix the login button. See N-1." : "Other work.",
  state: state.closed.includes(number) ? "closed" : "open",
  html_url: `https://github.com/acme/web/issues/${number}`,
  updated_at: "2026-11-08T10:00:00Z",
  user: { login: "sam" },
  assignees: assignee ? [{ login: assignee }] : [],
  labels: number === 5 ? [{ name: "bug" }] : [],
  milestone: number === 5 ? { title: "Sprint", due_on: "2026-11-20T00:00:00Z" } : null,
  comments: number === 5 ? 1 : 0,
  ...extra,
});

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-issues-")));
  server = createServer((request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
    const url = new URL(request.url ?? "/", "http://x");
    const p = url.pathname;
    if (p === "/user") return json(200, { login: "me" });
    if (p === "/repos/acme/web/issues") {
      const all = [issue(5, "Login button", "me"), issue(6, "Someone else's", "kim"), issue(8, "A pull request", "me", { pull_request: {} })].filter(
        (i) => !state.closed.includes(i.number),
      );
      const assignee = url.searchParams.get("assignee");
      return json(200, assignee ? all.filter((i) => i.assignees.some((a) => a.login === assignee)) : all);
    }
    if (p === "/repos/acme/web/issues/5/comments") return json(200, [{ user: { login: "kim" }, body: "Seen it too.", created_at: "2026-11-08T11:00:00Z" }]);
    const one = p.match(/^\/repos\/acme\/web\/issues\/(\d+)$/);
    if (one?.[1]) {
      const n = Number(one[1]);
      state.lookups++;
      if (n === 5) return json(200, issue(5, "Login button", "me"));
      if (n === 6) return json(200, issue(6, "Someone else's", "kim"));
      if (n === 8) return json(200, issue(8, "A pull request", "me", { pull_request: {} }));
    }
    if (p === "/repos/other/lib/issues/3") return json(200, { ...issue(3, "Elsewhere", null), html_url: "https://github.com/other/lib/issues/3" });
    return json(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_EXTRA_PLUGINS: PLUGIN, DEV_EXAMPLE_TOKEN: "good", DEV_GITHUB_API_URL: apiUrl, DEV_GITHUB_TOKEN: TOKEN },
      timeout: 60_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

async function workspace(scope = "{ assigned: me }"): Promise<string> {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  const init = await dev(root, ["init", "--versioning", "github", "--repo", "acme/web", "--clone-url", origin]);
  assert.equal(init.code, 0, init.err);
  assert.equal((await dev(root, ["add", "github-issues", "--scope", scope])).code, 0);
  assert.equal((await dev(root, ["add", "notes", "--scope", "{ book: team }"])).code, 0);
  return root;
}

test("issues sync keeps your open issues, one folder each, and leaves pull requests out", async () => {
  const root = await workspace();
  const first = await dev(root, ["sync", "github-issues"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /GitHub Issues: 1 new, 0 updated, 0 removed\./);

  const text = readFileSync(path.join(root, "github-issues", "acme-web-5", "issue.md"), "utf8");
  assert.match(text, /^---\nid: acme\/web#5\ntitle: Login button\nservice: github:github-issues\n/);
  assert.match(text, /mine: true\ndue: 2026-11-20\ninScope: true\nvia: scope/);
  assert.match(text, /### kim · 2026-11-08 11:00\n\nSeen it too\./);
  assert.ok(!existsSync(path.join(root, "github-issues", "acme-web-8")), "pull requests aren't issues");
  assert.ok(!existsSync(path.join(root, "github-issues", "acme-web-6")), "someone else's issue is out of scope");
  assert.ok(existsSync(path.join(root, "notes", "N-1.md")), "the sweep follows the issue's references");

  const index = readFileSync(path.join(root, "github-issues", "index.md"), "utf8");
  assert.match(index, /\| \[acme\/web#5\]\(acme-web-5\/issue\.md\) \| Login button \| open \| yes \| scope \|/);

  assert.match((await dev(root, ["sync", "github-issues"])).out, /0 new, 0 updated, 0 removed/);

  state.closed = [5];
  try {
    const closed = await dev(root, ["sync", "github-issues"]);
    assert.match(closed.out, /0 new, 1 updated, 0 removed/);
    assert.match(readFileSync(path.join(root, "github-issues", "acme-web-5", "issue.md"), "utf8"), /status: closed/);
    const before = state.lookups;
    assert.match((await dev(root, ["sync", "github-issues"])).out, /0 new, 0 updated, 0 removed/);
    assert.equal(state.lookups, before, "a closed issue isn't looked up again on every sync");
  } finally {
    state.closed = [];
  }
});

test("task list and the snapshot cover issues like any task source", async () => {
  const root = await workspace("{ assigned: any }");
  await dev(root, ["sync"]);
  const list = await dev(root, ["task", "list", "--mine"]);
  assert.match(list.out, /GitHub Issues, as of .*: 1 task\n {2}acme\/web#5 {2}\[open\] {2}Login button {2}· due 2026-11-20 · mine/);
  assert.match((await dev(root, ["task", "list"])).out, /2 tasks/);

  await dev(root, ["day", "start", "--no-sync"]);
  assert.match(readFileSync(path.join(root, "snapshot.md"), "utf8"), /## GitHub issues\n\n- \[acme\/web#5\]\(github-issues\/acme-web-5\/issue\.md\) Login button · mine\n- \[acme\/web#6\]/);
});

test("task start on an issue fetches it and what it links to, with a fix branch for a bug", async () => {
  const root = await workspace();
  const result = await dev(root, ["task", "start", "acme/web#5"]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /GitHub Issues: Login button/);
  assert.ok(result.out.includes(`on fix/${taskId("github-issues:acme/web#5")}-login-button`));
  const brief = readFileSync(path.join(root, "tasks", taskId("github-issues:acme/web#5"), "brief.md"), "utf8");
  assert.match(brief, /\[github-issues\/acme-web-5\/issue\.md\]/);
  assert.match(brief, /\[notes\/N-1\.md\]/);
});

test("pull accepts a number, a key or a link, and stays within the scope's repositories", async () => {
  const root = await workspace();
  assert.match((await dev(root, ["github-issues", "pull", "6"])).out, /github-issues\/acme-web-6\/issue\.md/);
  assert.match(readFileSync(path.join(root, "github-issues", "acme-web-6", "issue.md"), "utf8"), /via: pulled/);
  assert.match((await dev(root, ["github-issues", "pull", "8"])).err, /is a pull request, not an issue/);

  const outside = await dev(root, ["github-issues", "pull", "https://github.com/other/lib/issues/3"]);
  assert.equal(outside.code, 1);
  assert.match(outside.err, /outside this workspace's scope/);

  assert.match((await dev(root, ["github-issues", "scope", "add", "https://github.com/other/lib"])).out, /Done: added other\/lib/);
  assert.equal((await dev(root, ["github-issues", "pull", "other/lib#3"])).code, 0);
});

test("a PR that closes an issue links to it", async () => {
  const { issues } = await import("../src/plugins/github/issues.ts");
  const root = await workspace();
  const context = { root, scope: {}, settings: { fetch: "within-scope", sync: "full" } } as never;
  const found = issues.links?.find("Fixes #5, and see other/lib#3 and https://github.com/acme/web/issues/9. Not #4.", context);
  assert.deepEqual(found?.map((r) => r.id).sort(), ["acme/web#5", "acme/web#9", "other/lib#3"]);
});
