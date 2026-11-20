/** Task bases and merged pull or merge requests in cleanup (issue #7), against recorded GitHub and GitLab responses. */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { parseConfig } from "../src/core/project-config.ts";
import { GitHubApi } from "../src/plugins/github/api.ts";
import { changeRequests as githubChangeRequests } from "../src/plugins/github/pulls.ts";
import { GitLabApi } from "../src/plugins/gitlab/api.ts";
import { changeRequests as gitlabChangeRequests } from "../src/plugins/gitlab/merges.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const FIXTURES = path.join(import.meta.dirname, "fixtures", "change-requests");
const PULLS = JSON.parse(readFileSync(path.join(FIXTURES, "github-pulls.json"), "utf8")) as Record<string, Array<{ head: { sha: string } }>>;
const MERGES = JSON.parse(readFileSync(path.join(FIXTURES, "gitlab-merge-requests.json"), "utf8")) as Record<string, unknown[]>;
const exec = promisify(execFile);

let base: string;
let origin: string;
let server: Server;
let apiUrl: string;
/** Each branch's commit, standing in for "HEAD" in the recorded responses. */
const heads = new Map<string, string>();
/** The branches GitHub was asked about. */
const asked: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-cleanup-")));
  server = createServer((request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/v4/")) {
      if (request.headers["private-token"] !== "glpat-test") return json(401, { message: "401 Unauthorized" });
      if (url.pathname === "/api/v4/projects/team%2Fweb/merge_requests" && url.searchParams.get("state") === "all") {
        return json(200, MERGES[url.searchParams.get("source_branch") ?? ""] ?? []);
      }
      return json(404, { message: "404 Not Found" });
    }
    if (request.headers.authorization !== "Bearer ghp_fake") return json(401, { message: "Bad credentials" });
    if (url.pathname === "/user") return json(200, { login: "me" });
    if (url.pathname === "/repos/acme/web/pulls" && url.searchParams.get("state") === "all") {
      const branch = (url.searchParams.get("head") ?? "").replace(/^acme:/, "");
      asked.push(branch);
      const recorded = structuredClone(PULLS[branch] ?? []);
      for (const pr of recorded) if (pr.head.sha === "HEAD") pr.head.sha = heads.get(branch) ?? "unknown";
      return json(200, recorded);
    }
    return json(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // An origin with main and release/1.
  const seed = path.join(base, "seed");
  git(base, "init", "--quiet", "--initial-branch=main", seed);
  git(seed, "config", "user.email", "t@example.test");
  git(seed, "config", "user.name", "T");
  writeFileSync(path.join(seed, "README.md"), "code\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "start");
  git(seed, "branch", "release/1");
  origin = path.join(base, "origin.git");
  git(base, "clone", "--quiet", "--bare", seed, origin);
});

after(() => {
  server.close();
  rmSync(base, { recursive: true, force: true });
});

async function dev(cwd: string, args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_GITHUB_API_URL: apiUrl, DEV_GITHUB_TOKEN: "ghp_fake", ...env },
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
  const init = await dev(root, ["init", "--versioning", "github", "--repo", "acme/web", "--clone-url", origin]);
  assert.equal(init.code, 0, init.err);
  return root;
}

/** Starts a task and commits one file on its branch. Returns the worktree. */
async function work(root: string, id: string, extra: string[] = []): Promise<string> {
  const started = await dev(root, ["task", "start", id, ...extra]);
  assert.equal(started.code, 0, started.err);
  const dir = path.join(root, "worktrees", id);
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, `${id}.txt`), `${id}\n`);
  git(dir, "add", `${id}.txt`);
  git(dir, "commit", "--quiet", "-m", `Work on ${id}`);
  heads.set(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), git(dir, "rev-parse", "HEAD"));
  return dir;
}

/** Plays the host: merges a pushed branch into `into` (squashed or not), then deletes the branch. */
function merge(branch: string, into: string, how: "merge" | "squash"): void {
  const maintainer = realpathSync(mkdtempSync(path.join(base, "maintainer-")));
  git(base, "clone", "--quiet", origin, maintainer);
  git(maintainer, "config", "user.email", "m@example.test");
  git(maintainer, "config", "user.name", "M");
  git(maintainer, "checkout", "--quiet", into);
  if (how === "merge") git(maintainer, "merge", "--quiet", "--no-ff", "-m", `Merge ${branch}`, `origin/${branch}`);
  else {
    git(maintainer, "merge", "--quiet", "--squash", `origin/${branch}`);
    git(maintainer, "commit", "--quiet", "-m", `${branch} (squashed)`);
  }
  git(maintainer, "push", "--quiet", "origin", into, `:${branch}`);
}

test("GitHub's PRs for a branch: newest first, merged told from closed, forks left out", async () => {
  process.env.DEV_GITHUB_API_URL = apiUrl;
  heads.set("feature/squashed-squashed", "abc123");
  heads.set("feature/open-open", "def456");
  try {
    const api = new GitHubApi("ghp_fake");
    assert.deepEqual(await githubChangeRequests(api, "acme/web", "feature/squashed-squashed"), [
      { number: 8, url: "https://github.com/acme/web/pull/8", state: "merged", draft: false, base: "main", headSha: "abc123", mergedAt: "2026-11-18T09:12:44Z" },
      { number: 7, url: "https://github.com/acme/web/pull/7", state: "closed", draft: false, base: "main", headSha: "0b4c1a5e2f8d9c3b7a6e5d4c3b2a1f0e9d8c7b6a", mergedAt: null },
    ]);
    const open = await githubChangeRequests(api, "acme/web", "feature/open-open");
    assert.deepEqual(open.map((pr) => [pr.number, pr.state, pr.draft, pr.base]), [[10, "open", true, "release/1"]], "the fork's PR isn't the task's");
    assert.deepEqual(await githubChangeRequests(api, "acme/web", "feature/none"), []);
  } finally {
    delete process.env.DEV_GITHUB_API_URL;
  }
});

test("GitLab's MRs for a branch: merged, closed and locked mapped, forks left out", async () => {
  const api = new GitLabApi({ host: apiUrl, token: "glpat-test" });
  assert.deepEqual(await gitlabChangeRequests(api, "team/web", "feature/squashed-squashed"), [
    { number: 14, url: "https://gitlab.com/team/web/-/merge_requests/14", state: "merged", draft: false, base: "develop", headSha: "3f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49", mergedAt: "2026-11-18T09:12:44.120Z" },
    { number: 12, url: "https://gitlab.com/team/web/-/merge_requests/12", state: "closed", draft: false, base: "develop", headSha: "0b4c1a5e2f8d9c3b7a6e5d4c3b2a1f0e9d8c7b6a", mergedAt: null },
  ]);
  assert.deepEqual((await gitlabChangeRequests(api, "team/web", "feature/open-open")).map((mr) => [mr.number, mr.state, mr.draft]), [[15, "open", true], [13, "open", false]]);
  assert.deepEqual(await gitlabChangeRequests(api, "team/web", "feature/none"), []);
});

test("conventions.base must be a branch name", () => {
  assert.equal(parseConfig("version: 1\nconventions:\n  base: release/1.2\n").config.conventions.base, "release/1.2");
  for (const bad of ["base: 3", "base: ../x", "base: 'a b'", "base: release/"]) {
    assert.match(parseConfig(`version: 1\nconventions:\n  ${bad}\n`).problems.map((p) => p.message).join(), /"conventions\.base" should be a branch name/, bad);
  }
});

test("each task is checked against its own base, and a branch merged into it can go", async () => {
  const root = await workspace();
  const dir = await work(root, "rel", ["--base", "release/1"]);
  assert.match(readFileSync(path.join(root, "tasks", "rel", "brief.md"), "utf8"), /\nbranch: "feature\/rel-rel"\nbase: "release\/1"\nworktree:/);
  git(dir, "push", "--quiet", "origin", "feature/rel-rel");

  const before = await dev(root, ["task", "cleanup"]);
  assert.match(before.out, /Keep rel: 1 commit\(s\) not in release\/1\./, "named after its own base, not main");
  assert.match((await dev(root, ["task", "status"])).out, /rel {2}feature\/rel-rel {2}1 commit/);

  merge("feature/rel-rel", "release/1", "merge");
  asked.length = 0;
  const removed = await dev(root, ["task", "cleanup", "--remove"]);
  assert.equal(removed.code, 0, removed.err);
  assert.match(removed.out, /Removed worktrees\/rel\./);
  assert.ok(!asked.includes("feature/rel-rel"), "git alone cleared it, so GitHub wasn't asked");
});

test("a brief from before dev recorded the base falls back to conventions.base, else the default branch", async () => {
  const root = await workspace();
  const dir = await work(root, "old", ["--base", "release/1"]);
  git(dir, "push", "--quiet", "origin", "feature/old-old");
  merge("feature/old-old", "release/1", "merge");
  const brief = path.join(root, "tasks", "old", "brief.md");
  writeFileSync(brief, readFileSync(brief, "utf8").replace(/^base: .*\n/m, ""));

  assert.match((await dev(root, ["task", "cleanup"])).out, /Keep old: \d+ commit\(s\) not in main\./);
  writeFileSync(path.join(root, "dev.yaml"), `${readFileSync(path.join(root, "dev.yaml"), "utf8")}conventions:\n  base: release/1\n`);
  assert.match((await dev(root, ["task", "cleanup"])).out, /Safe to remove, nothing would be lost: old\./);

  // And new tasks start from conventions.base and record it.
  await dev(root, ["task", "start", "next"]);
  assert.match(readFileSync(path.join(root, "tasks", "next", "brief.md"), "utf8"), /\nbase: "release\/1"\n/);
});

test("a squash-merged branch can go when its PR merged the worktree's last commit, and not otherwise", async () => {
  const root = await workspace();
  for (const id of ["squashed", "moved"]) {
    const dir = await work(root, id);
    git(dir, "push", "--quiet", "origin", `feature/${id}-${id}`);
    merge(`feature/${id}-${id}`, "main", "squash");
  }
  // moved's PR (#9) merged an earlier commit than the one checked out.
  const report = await dev(root, ["task", "cleanup"]);
  assert.equal(report.code, 0, report.err);
  assert.match(report.out, /Keep moved: 1 commit\(s\) not in main, https:\/\/github\.com\/acme\/web\/pull\/9 merged an earlier commit\./);
  assert.match(report.out, /Safe to remove, nothing would be lost: squashed \(merged by https:\/\/github\.com\/acme\/web\/pull\/8\)\./);

  // Offline from GitHub, only git counts, and the squashed branch is kept.
  const offline = await dev(root, ["task", "cleanup", "--remove"], { DEV_GITHUB_API_URL: "http://127.0.0.1:1" });
  assert.equal(offline.code, 0, offline.err);
  assert.match(offline.err, /Couldn't ask GitHub which branches were merged \(Couldn't reach GitHub/);
  assert.match(offline.out, /Nothing is safe to remove\./);
  assert.ok(existsSync(path.join(root, "worktrees", "squashed")));

  const removed = await dev(root, ["task", "cleanup", "--remove"]);
  assert.equal(removed.code, 0, removed.err);
  assert.ok(!existsSync(path.join(root, "worktrees", "squashed")));
  assert.ok(existsSync(path.join(root, "worktrees", "moved")));
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "feature/squashed-squashed"], { cwd: path.join(root, "repository") }).status, 1, "its branch is gone");
  assert.ok(existsSync(path.join(root, "tasks", "squashed", "brief.md")), "notes stay");
});

test("uncommitted work is never removed, whatever the PR says", async () => {
  const root = await workspace();
  const dir = await work(root, "dirty");
  writeFileSync(path.join(dir, "draft.txt"), "not yet\n");
  asked.length = 0;
  const report = await dev(root, ["task", "cleanup", "--remove"]);
  assert.match(report.out, /Keep dirty: 1 commit\(s\) not in main, 1 uncommitted change\(s\)\./);
  assert.deepEqual(asked, [], "a dirty worktree isn't worth asking about");
  assert.ok(existsSync(dir));
});
