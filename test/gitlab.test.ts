import { taskId } from "../src/core/tasks.ts";
/** GitLab: versioning, merge requests to review and issues, against a fake GitLab server. */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { glabPolicy } from "../src/plugins/gitlab/policy.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGIN = path.join(import.meta.dirname, "fixtures", "example-plugin.ts");
const exec = promisify(execFile);

let base: string;
let origin: string;
let server: Server;
let host: string;

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-gitlab-")));
  server = createServer((request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.headers["private-token"] !== "glpat-test") return json(401, { message: "401 Unauthorized" });
    const url = new URL(request.url ?? "/", "http://x");
    const p = url.pathname.replace("/api/v4", "");
    const mr = (iid: number, author: string, extra = {}) => ({ iid, title: `MR ${iid}`, author: { username: author }, draft: false, updated_at: "2026-11-08T10:00:00Z", web_url: `${host}/team/web/-/merge_requests/${iid}`, ...extra });
    if (p === "/user") return json(200, { username: "me" });
    if (p === "/projects") return json(200, [{ path_with_namespace: "team/web", description: "The app", archived: false }]);
    if (p === "/projects/team%2Fweb/merge_requests") return json(200, [mr(3, "alex"), mr(4, "me")]);
    if (p === "/projects/team%2Fweb/merge_requests/3") return json(200, { ...mr(3, "alex"), description: "Closes #5. Spec in N-1.", state: "opened", source_branch: "fix/x", target_branch: "main" });
    if (p === "/projects/team%2Fweb/merge_requests/3/diffs") return json(200, [{ new_path: "src/a.ts", new_file: true }]);
    if (p === "/projects/team%2Fweb/merge_requests/3/notes") return json(200, [{ author: { username: "kim" }, body: "Rename this.", created_at: "2026-11-08T11:00:00Z", position: { new_path: "src/a.ts", new_line: 4 } }, { system: true, body: "added 1 commit" }]);
    const issue = { iid: 5, title: "Broken login", description: "See N-2.", state: "opened", web_url: `${host}/team/web/-/issues/5`, updated_at: "2026-11-08T09:00:00Z", due_date: "2026-11-20", author: { username: "sam" }, assignees: [{ username: "me" }], labels: ["bug"], user_notes_count: 0 };
    if (p === "/projects/team%2Fweb/issues") return json(200, url.searchParams.get("assignee_username") === "me" ? [issue] : [issue, { ...issue, iid: 6, title: "Other", assignees: [] }]);
    if (p === "/projects/team%2Fweb/issues/5") return json(200, issue);
    return json(404, { message: "404 Not Found" });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_EXTRA_PLUGINS: PLUGIN, DEV_EXAMPLE_TOKEN: "good", DEV_GITLAB_HOST: host, DEV_GITLAB_TOKEN: "glpat-test" },
      timeout: 60_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

async function workspace(): Promise<string> {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  const init = await dev(root, ["init", "--versioning", "gitlab", "--repo", "team/web", "--clone-url", origin]);
  assert.equal(init.code, 0, init.err);
  assert.equal((await dev(root, ["add", "gitlab-issues", "--scope", "{ assigned: me }"])).code, 0);
  assert.equal((await dev(root, ["add", "notes", "--scope", "{ book: team }"])).code, 0);
  return root;
}

test("a GitLab workspace pulls merge requests to review, with comments and linked items", async () => {
  const root = await workspace();
  assert.ok(existsSync(path.join(root, "repository", "README.md")));
  assert.match((await dev(root, ["doctor"])).out, /GitLab: logged in as me/);

  const { code, out, err } = await dev(root, ["gitlab", "mrs"]);
  assert.equal(code, 0, err);
  assert.match(out, /team\/web: 2 open, 1 to consider\.\n {2}!3 \[new\] alex: MR 3/);
  const description = readFileSync(path.join(root, "merge-requests", "3", "mr-description.md"), "utf8");
  assert.match(description, /^---\nid: "3"\ntitle: MR 3\nservice: gitlab:gitlab\n/);
  assert.match(description, /- team\/web#5: \[gitlab-issues\/team-web-5\/issue\.md\]/, "closes #5 is fetched as an issue");
  assert.match(description, /- N-1: \[notes\/N-1\.md\]/);
  assert.match(description, /- `src\/a\.ts` \(new\)/);
  const comments = readFileSync(path.join(root, "merge-requests", "3", "comments.md"), "utf8");
  assert.match(comments, /kim · 2026-11-08 11:00 · `src\/a\.ts:4`\n\nRename this\./);
  assert.doesNotMatch(comments, /added 1 commit/, "system notes are left out");
  assert.match((await dev(root, ["gitlab", "mrs"])).out, /!3 \[unreviewed\]/);
});

test("GitLab issues sync like any task source", async () => {
  const root = await workspace();
  const synced = await dev(root, ["sync", "gitlab-issues"]);
  assert.equal(synced.code, 0, synced.err);
  assert.match(synced.out, /GitLab Issues: 1 new/);
  const text = readFileSync(path.join(root, "gitlab-issues", "team-web-5", "issue.md"), "utf8");
  assert.match(text, /mine: true\ndue: 2026-11-20\ninScope: true/);
  assert.ok(existsSync(path.join(root, "notes", "N-2.md")), "the sweep follows the issue's references");
  assert.match((await dev(root, ["task", "list", "--mine"])).out, /GitLab Issues, as of .*: 1 task\n {2}team\/web#5 {2}\[open\] {2}Broken login/);
  assert.ok((await dev(root, ["task", "start", "team/web#5"])).out.includes(`on fix/${taskId("gitlab-issues:team/web#5")}-broken-login`));
});

test("glab commands are checked like gh's", () => {
  assert.equal(glabPolicy.classify(["mr", "view", "3"]).kind, "read");
  assert.equal(glabPolicy.classify(["mr", "diff", "3"]).kind, "read");
  assert.equal(glabPolicy.classify(["mr", "merge", "3"]).kind, "change");
  assert.equal(glabPolicy.classify(["mr", "note", "3", "-m", "hi"]).kind, "change");
  assert.equal(glabPolicy.classify(["api", "projects/1/issues"]).kind, "read");
  assert.equal(glabPolicy.classify(["api", "-X", "POST", "projects/1/issues"]).kind, "change");
  assert.equal(glabPolicy.classify(["mr", "merge", "--help"]).command, "help");
  assert.equal(glabPolicy.classify(["mystery"]).kind, "unknown");
});
