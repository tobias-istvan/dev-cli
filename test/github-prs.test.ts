/** Pulling PRs for review, against a fake GitHub API. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGIN = path.join(import.meta.dirname, "fixtures", "example-plugin.ts");
const TOKEN = "ghp_fake";

let base: string;
let server: Server;
let apiUrl: string;
let firstUpdated = "2026-11-01T10:00:00Z";

const summary = (number: number, author: string, draft: boolean, title: string, updated = "2026-11-01T10:00:00Z") => ({
  number,
  title,
  user: { login: author },
  draft,
  updated_at: updated,
  html_url: `https://github.test/acme/web/pull/${number}`,
});

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-prs-")));
  server = createServer((request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: "Bad credentials" });

    const { pathname } = new URL(request.url ?? "/", "http://x");
    if (pathname === "/user") return json(200, { login: "me" });
    if (pathname === "/repos/acme/web/pulls") {
      return json(200, [
        summary(1, "alex", false, "Fix the login button", firstUpdated),
        summary(2, "me", false, "My own work"),
        summary(3, "sam", true, "Early draft"),
      ]);
    }
    if (pathname === "/repos/acme/web/pulls/1") {
      return json(200, {
        ...summary(1, "alex", false, "Fix the login button", firstUpdated),
        body: "Closes N-1.",
        state: "open",
        merged_at: null,
        base: { ref: "main" },
        head: { ref: "fix/login", repo: { full_name: "acme/web" } },
        additions: 3,
        deletions: 1,
        changed_files: 1,
      });
    }
    if (pathname === "/repos/acme/web/pulls/2") {
      return json(200, { ...summary(2, "fan", false, "From a fork"), body: "", state: "open", merged_at: null, base: { ref: "main" }, head: { ref: "main", repo: { full_name: "fan/web" } }, additions: 1, deletions: 0, changed_files: 1 });
    }
    if (/^\/repos\/acme\/web\/(pulls\/2\/(files|reviews|comments)|issues\/2\/comments)$/.test(pathname)) return json(200, []);
    if (pathname === "/repos/acme/web/pulls/9") return json(200, { ...summary(9, "alex", false, "Old"), state: "closed", merged_at: "2026-10-30T00:00:00Z" });
    if (pathname === "/repos/acme/web/pulls/1/files") return json(200, [{ filename: "src/login.ts", additions: 3, deletions: 1 }]);
    if (pathname === "/repos/acme/web/issues/1/comments") return json(200, [{ user: { login: "sam" }, body: "Looks close.", created_at: "2026-11-01T11:00:00Z" }]);
    if (pathname === "/repos/acme/web/pulls/1/reviews") return json(200, [{ user: { login: "kim" }, body: "", state: "APPROVED", submitted_at: "2026-11-01T12:00:00Z" }]);
    if (pathname === "/repos/acme/web/pulls/1/comments") return json(200, [{ user: { login: "kim" }, body: "Rename this.", created_at: "2026-11-01T09:00:00Z", path: "src/login.ts", line: 4 }]);
    return json(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(base, { recursive: true, force: true });
});

const exec = promisify(execFile);

/** Runs dev without blocking, so the fake server in this process can answer it. */
async function dev(cwd: string, args: string[]) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(base, "config"),
        DEV_EXTRA_PLUGINS: PLUGIN,
        DEV_GITHUB_API_URL: apiUrl,
        DEV_GITHUB_TOKEN: TOKEN,
        DEV_EXAMPLE_TOKEN: "good",
      },
      timeout: 60_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

function workspace(): string {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  writeFileSync(path.join(root, "dev.yaml"), "version: 1\nversioning: { service: github:github, repo: acme/web }\nservices:\n  - service: example:notes\n    scope: { book: team }\n");
  return root;
}

test("prs pulls others' open PRs with their comments and linked items, and marks merged ones", async () => {
  const root = workspace();
  mkdirSync(path.join(root, "pull-requests", "9"), { recursive: true });
  writeFileSync(path.join(root, "pull-requests", "9", "review.md"), "old review\n");
  writeFileSync(path.join(root, "pull-requests", "9", "pr-description.md"), "---\nid: \"9\"\ntitle: Old\nservice: github:github\nurl: u\nupdated: x\nsynced: y\nstatus: open\n---\n\nOld\n");

  const { code, out, err } = await dev(root, ["github", "prs"]);
  assert.equal(code, 0, err);
  assert.match(out, /acme\/web: 3 open, 1 to consider\./);
  assert.match(out, /#1 \[new\] alex: Fix the login button/);
  assert.match(out, /#9 was merged since it was pulled\. Its folder stays, marked merged\./);
  assert.match(out, /Done: 1 to review: #1\./);
  assert.equal(readFileSync(path.join(root, "pull-requests", "9", "review.md"), "utf8"), "old review\n", "the review stays on record");
  assert.match(readFileSync(path.join(root, "pull-requests", "9", "pr-description.md"), "utf8"), /status: merged/);
  assert.doesNotMatch((await dev(root, ["github", "prs"])).out, /#9/, "it's only reported once");
  assert.ok(!existsSync(path.join(root, "pull-requests", "2")), "your own PRs are skipped");
  assert.ok(!existsSync(path.join(root, "pull-requests", "3")), "drafts are skipped");

  const description = readFileSync(path.join(root, "pull-requests", "1", "pr-description.md"), "utf8");
  assert.match(description, /^---\nid: "1"\ntitle: Fix the login button\nservice: github:github\n/);
  assert.match(description, /status: open\nlinks:\n {2}- notes\/N-1\.md\nauthor: alex\n/);
  assert.match(description, /- N-1: \[notes\/N-1\.md\]\(\.\.\/\.\.\/notes\/N-1\.md\)/);
  assert.ok(existsSync(path.join(root, "notes", "N-1.md")), "the linked item was fetched");

  const comments = readFileSync(path.join(root, "pull-requests", "1", "comments.md"), "utf8");
  assert.match(comments, /kim · 2026-11-01 09:00 · inline comment · `src\/login\.ts:4`\n\nRename this\.[\s\S]*sam · 2026-11-01 11:00 · comment\n\nLooks close\./);
  assert.ok(!comments.includes("approved"), "a review with no text is left out");

  const index = readFileSync(path.join(root, "pull-requests", "index.md"), "utf8");
  assert.match(index, /\| \[1\]\(1\/pr-description\.md\) \| Fix the login button \| open \| 2026-11-01 \|/);
  assert.match(index, /2 items\./);
  assert.match(index, /\| \[9\]\(9\/pr-description\.md\) \| Old \| merged \|/);
});

test("a PR moves from unreviewed to current to updated", async () => {
  const root = workspace();
  await dev(root, ["github", "prs"]);
  assert.match((await dev(root, ["github", "prs"])).out, /#1 \[unreviewed\]/);

  writeFileSync(path.join(root, "pull-requests", "1", "review.md"), "# PR #1: Fix the login button\n");
  const current = await dev(root, ["github", "prs"]);
  assert.match(current.out, /#1 \[current\]/);
  assert.match(current.out, /Done: nothing to review\./);

  firstUpdated = "2026-11-02T10:00:00Z";
  try {
    assert.match((await dev(root, ["github", "prs", "--no-pull"])).out, /#1 \[updated\][\s\S]*Not pulled, because of --no-pull/);
    assert.match((await dev(root, ["github", "prs"])).out, /#1 \[updated\]/);
    assert.match(readFileSync(path.join(root, "pull-requests", "1", "pr-description.md"), "utf8"), /updated: 2026-11-02T10:00:00Z/);
    assert.equal(readFileSync(path.join(root, "pull-requests", "1", "review.md"), "utf8"), "# PR #1: Fix the login button\n", "the review is never touched");
  } finally {
    firstUpdated = "2026-11-01T10:00:00Z";
  }
});

test("pr pulls one PR on demand, and --json gives only JSON", async () => {
  const root = workspace();
  const one = await dev(root, ["github", "pr", "1"]);
  assert.equal(one.code, 0, one.err);
  assert.match(one.out, /#1: 2 comments, linked notes\/N-1\.md\./);
  assert.match((await dev(root, ["github", "pr", "abc"])).err, /"abc" isn't a PR number/);

  const json = JSON.parse((await dev(root, ["github", "prs", "--json", "--no-pull"])).out);
  assert.equal(json.repo, "acme/web");
  assert.deepEqual(json.needsReview.map((pr: { number: number }) => pr.number), [1]);
});

test("pr --worktree checks out the PR's own branch, never a detached commit", async () => {
  const { spawnSync } = await import("node:child_process");
  const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const seed = path.join(base, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "--quiet", "--initial-branch=main");
  git(seed, "config", "user.email", "t@example.test");
  git(seed, "config", "user.name", "T");
  writeFileSync(path.join(seed, "README.md"), "code\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "start");
  git(seed, "switch", "--quiet", "-c", "fix/login");
  writeFileSync(path.join(seed, "login.ts"), "fixed\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "Fix login");
  git(seed, "switch", "--quiet", "main");
  const origin = path.join(base, "origin-prs.git");
  git(base, "clone", "--quiet", "--bare", seed, origin);
  // A fork's PR is only reachable through the host's special ref.
  git(origin, "update-ref", "refs/pull/2/head", git(origin, "rev-parse", "fix/login").stdout.trim());

  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  assert.equal((await dev(root, ["init", "--versioning", "github", "--repo", "acme/web", "--clone-url", origin])).code, 0);

  const pulled = await dev(root, ["github", "pr", "1", "--worktree"]);
  assert.equal(pulled.code, 0, pulled.err);
  assert.match(pulled.out, /Worktree: worktrees\/pr-1 on fix\/login\. Open it with: code worktrees\/pr-1/);
  const tree = path.join(root, "worktrees", "pr-1");
  assert.equal(git(tree, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim(), "fix/login", "on the branch, not detached");
  assert.equal(git(tree, "rev-parse", "--abbrev-ref", "@{upstream}").stdout.trim(), "origin/fix/login", "tracking it, so pushes go back to the PR");
  assert.ok(existsSync(path.join(tree, "login.ts")));
  assert.match((await dev(root, ["github", "pr", "1", "--worktree"])).out, /already there/);

  const fork = await dev(root, ["github", "pr", "2", "--worktree"]);
  assert.equal(fork.code, 0, fork.err);
  assert.equal(git(path.join(root, "worktrees", "pr-2"), "rev-parse", "--abbrev-ref", "HEAD").stdout.trim(), "pr-2");

  assert.match((await dev(root, ["task", "cleanup"])).out, /Safe to remove, nothing would be lost: pr-1/, "everything in it is on the PR's branch");
  assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /dev github pr <N> --worktree/);
});
