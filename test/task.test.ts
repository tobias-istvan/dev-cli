import { taskId } from "../src/core/tasks.ts";
/** Tasks and worktrees, against a local origin repository. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGIN = path.join(import.meta.dirname, "fixtures", "example-plugin.ts");

let base: string;
let origin: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

before(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-task-")));
  // An origin with a main branch, a PR template, and an ignored local settings file.
  const seed = path.join(base, "seed");
  mkdirSync(path.join(seed, ".github"), { recursive: true });
  git(seed, "init", "--quiet", "--initial-branch=main");
  git(seed, "config", "user.email", "t@example.test");
  git(seed, "config", "user.name", "T");
  writeFileSync(path.join(seed, "README.md"), "code\n");
  writeFileSync(path.join(seed, ".gitignore"), ".env.local\n");
  writeFileSync(path.join(seed, ".github", "PULL_REQUEST_TEMPLATE.md"), "## What\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "start");
  origin = path.join(base, "origin.git");
  git(base, "clone", "--quiet", "--bare", seed, origin);
});

after(() => rmSync(base, { recursive: true, force: true }));

function dev(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_EXTRA_PLUGINS: PLUGIN, DEV_EXAMPLE_TOKEN: "good" },
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function workspace(): string {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  const init = dev(root, ["init", "--versioning", "example:code", "--repo", "acme/web", "--clone-url", origin, "--service", "notes"]);
  assert.equal(init.code, 0, init.err);
  writeFileSync(path.join(root, "repository", ".env.local"), "SECRET=1\n");
  writeFileSync(path.join(root, "repository", "notes.txt"), "tracked-looking\n");
  writeFileSync(
    path.join(root, "dev.yaml"),
    `${readFileSync(path.join(root, "dev.yaml"), "utf8")}conventions:\n  worktreeFiles: [.env.local, notes.txt]\n`,
  );
  return root;
}

test("task start creates the worktree, branch and notes, and is safe to re-run", () => {
  const root = workspace();
  const { code, out, err } = dev(root, ["task", "start", "Add dark mode!"]);
  assert.equal(code, 0, err);

  const dir = path.join(root, "worktrees", taskId("Add dark mode!"));
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), `feature/${taskId("Add dark mode!")}-add-dark-mode`);
  const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: dir });
  assert.notEqual(upstream.status, 0, "the branch has no upstream until it's pushed");
  assert.match(out, /Copied \.env\.local from the clone/);
  assert.match(err, /Didn't copy notes\.txt: git doesn't ignore it/);
  assert.equal(readFileSync(path.join(dir, ".env.local"), "utf8"), "SECRET=1\n");

  const brief = readFileSync(path.join(root, "tasks", taskId("Add dark mode!"), "brief.md"), "utf8");
  assert.ok(brief.startsWith(`---\nid: "${taskId("Add dark mode!")}"\ntitle: "Add dark mode!"`));
  assert.match(brief, /repository\/\.github\/PULL_REQUEST_TEMPLATE\.md/);
  assert.ok(existsSync(path.join(root, "tasks", taskId("Add dark mode!"), "progress.md")));

  // The workspace instructions are in the worktree but kept out of git.
  assert.ok(existsSync(path.join(dir, ".github", "instructions", "dev-workspace.instructions.md")));
  assert.equal(git(dir, "status", "--porcelain"), "");

  writeFileSync(path.join(root, "tasks", taskId("Add dark mode!"), "brief.md"), "mine\n");
  const again = dev(root, ["task", "start", "Add dark mode!"]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already there and left as it was/);
  assert.equal(readFileSync(path.join(root, "tasks", taskId("Add dark mode!"), "brief.md"), "utf8"), "mine\n");
});

test("task start fetches an item a service recognises, and what it links to", () => {
  const root = workspace();
  const { code, out, err } = dev(root, ["task", "start", "N-1"]);
  assert.equal(code, 0, err);
  assert.match(out, /Example notes: Fix the login button/);
  assert.equal(git(path.join(root, "worktrees", "N-1"), "rev-parse", "--abbrev-ref", "HEAD"), "fix/N-1-fix-the-login-button");

  assert.ok(existsSync(path.join(root, "notes", "N-1.md")));
  assert.ok(existsSync(path.join(root, "notes", "N-2.md")), "the linked item is fetched too");
  const brief = readFileSync(path.join(root, "tasks", "N-1", "brief.md"), "utf8");
  assert.match(brief, /- \[notes\/N-1\.md\]\(\.\.\/\.\.\/notes\/N-1\.md\)/);
  assert.match(brief, /- \[notes\/N-2\.md\]\(\.\.\/\.\.\/notes\/N-2\.md\)/);
});

test("task status and cleanup report what's in flight, and remove only what's safe", () => {
  const root = workspace();
  dev(root, ["task", "start", "idle"]);
  dev(root, ["task", "start", "busy"]);
  const busy = path.join(root, "worktrees", "busy");
  git(busy, "config", "user.email", "t@example.test");
  git(busy, "config", "user.name", "T");
  writeFileSync(path.join(busy, "change.txt"), "x\n");
  git(busy, "add", ".");
  git(busy, "commit", "--quiet", "-m", "Work in progress");
  writeFileSync(path.join(busy, "more.txt"), "y\n");

  const status = dev(root, ["task", "status"]);
  assert.match(status.out, /busy {2}feature\/busy-busy {2}1 commit, 1 uncommitted/);
  assert.match(status.out, /idle {2}feature\/idle-idle {2}0 commits, 0 uncommitted/);
  assert.match(dev(root, ["task", "status", "busy"]).out, /Commits not yet in main: 1\n {2}\w+ Work in progress/);
  assert.match(dev(root, ["task", "status", "nope"]).err, /no worktree for nope/);

  const report = dev(root, ["task", "cleanup"]);
  assert.match(report.out, /Keep busy: 1 commit\(s\) not in main, 1 uncommitted change\(s\)/);
  assert.match(report.out, /Safe to remove, nothing would be lost: idle/);
  assert.ok(existsSync(path.join(root, "worktrees", "idle")), "nothing is removed without --remove");

  const removed = dev(root, ["task", "cleanup", "--remove"]);
  assert.equal(removed.code, 0, removed.err);
  assert.ok(!existsSync(path.join(root, "worktrees", "idle")));
  assert.ok(existsSync(path.join(root, "worktrees", "busy")));
  assert.ok(existsSync(path.join(root, "tasks", "idle", "brief.md")), "notes stay");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "feature/idle-idle"], { cwd: path.join(root, "repository") }).status, 1, "its branch is gone");
});

test("a task started before ids had a hash is resumed under its old id", () => {
  const root = workspace();
  mkdirSync(path.join(root, "tasks", "fix-the-login"), { recursive: true });
  writeFileSync(path.join(root, "tasks", "fix-the-login", "brief.md"), "mine\n");
  const started = dev(root, ["task", "start", "Fix the login"]);
  assert.equal(started.code, 0, started.err);
  assert.ok(existsSync(path.join(root, "worktrees", "fix-the-login")), "the old id is kept");
  assert.ok(!existsSync(path.join(root, "tasks", taskId("Fix the login"))), "no second task folder");
  assert.equal(readFileSync(path.join(root, "tasks", "fix-the-login", "brief.md"), "utf8"), "mine\n");
});

test("cleanup works offline and around a broken worktree, and never counts either as safe", () => {
  const root = workspace();
  dev(root, ["task", "start", "idle"]);
  mkdirSync(path.join(root, "worktrees", "broken"), { recursive: true });
  writeFileSync(path.join(root, "worktrees", "broken", ".git"), "gitdir: /nonexistent/worktree\n");
  git(path.join(root, "repository"), "remote", "set-url", "origin", path.join(root, "no-such-origin"));

  const status = dev(root, ["task", "status"]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /idle {2}feature\/idle-idle/);
  assert.match(status.err, /broken {2}can't be read/);

  const removed = dev(root, ["task", "cleanup", "--remove"]);
  assert.equal(removed.code, 0, removed.err);
  assert.match(removed.err, /Couldn't reach the repository's remote/);
  assert.match(removed.err, /Keep broken: git can't read it/);
  assert.ok(!existsSync(path.join(root, "worktrees", "idle")), "a worktree with nothing in it goes, even offline");
  assert.ok(existsSync(path.join(root, "worktrees", "broken")));
});

test("task commands need a clone", () => {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  dev(root, ["init", "--versioning", "example:code", "--repo", "acme/web", "--no-clone"]);
  const { code, err } = dev(root, ["task", "start", "x"]);
  assert.equal(code, 1);
  assert.match(err, /no code clone in repository\/\.\nFix: Run "dev init"/);
});

test("a clone with no remote, or a remote not called origin, still works", () => {
  for (const setup of ["none", "upstream"] as const) {
    const root = realpathSync(mkdtempSync(path.join(base, `ws-${setup}-`)));
    assert.equal(dev(root, ["init", "--versioning", "example:code", "--repo", "acme/web", "--no-clone", "--service", "notes"]).code, 0);
    // A project that only lives here, on master, or one whose remote has another name.
    const repo = path.join(root, "repository");
    if (setup === "none") {
      mkdirSync(repo);
      git(repo, "init", "--quiet", "--initial-branch=master");
      git(repo, "config", "user.email", "t@example.test");
      git(repo, "config", "user.name", "T");
      writeFileSync(path.join(repo, "README.md"), "code\n");
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "start");
    } else {
      git(root, "clone", "--quiet", "--origin", "upstream", origin, "repository");
    }

    const started = dev(root, ["task", "start", "local-thing", "--title", "Local thing"]);
    assert.equal(started.code, 0, started.err);
    const worktree = path.join(root, "worktrees", "local-thing");
    git(worktree, "config", "user.email", "t@example.test");
    git(worktree, "config", "user.name", "T");
    writeFileSync(path.join(worktree, "work.txt"), "work\n");
    git(worktree, "add", "work.txt");
    git(worktree, "commit", "--quiet", "-m", "Do the local thing");

    const status = dev(root, ["task", "status"]);
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /1 commit/, `${setup}: commits are counted against the ${setup === "none" ? "local" : "remote"} base`);

    const day = dev(root, ["day", "start"]);
    assert.doesNotMatch(day.err, /Code: couldn't update/, day.err);
    assert.match(day.out, setup === "none" ? /Code: the clone in repository\/ has no remote, so there was nothing to fetch\. Worktrees start from the local master\./ : /Code: main is current\./);
    const cleanup = dev(root, ["task", "cleanup"]);
    assert.equal(cleanup.code, 0, cleanup.err);
    if (setup === "none") assert.doesNotMatch(cleanup.err, /Couldn't reach/, "no remote isn't an unreachable one");
  }
});
