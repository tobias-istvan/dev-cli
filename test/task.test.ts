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

  const dir = path.join(root, "worktrees", "add-dark-mode");
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "feature/add-dark-mode-add-dark-mode");
  const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: dir });
  assert.notEqual(upstream.status, 0, "the branch has no upstream until it's pushed");
  assert.match(out, /Copied \.env\.local from the clone/);
  assert.match(err, /Didn't copy notes\.txt: git doesn't ignore it/);
  assert.equal(readFileSync(path.join(dir, ".env.local"), "utf8"), "SECRET=1\n");

  const brief = readFileSync(path.join(root, "tasks", "add-dark-mode", "brief.md"), "utf8");
  assert.match(brief, /^---\nid: "add-dark-mode"\ntitle: "Add dark mode!"/);
  assert.match(brief, /repository\/\.github\/PULL_REQUEST_TEMPLATE\.md/);
  assert.ok(existsSync(path.join(root, "tasks", "add-dark-mode", "progress.md")));

  // The workspace instructions are in the worktree but kept out of git.
  assert.ok(existsSync(path.join(dir, ".github", "instructions", "dev-workspace.instructions.md")));
  assert.equal(git(dir, "status", "--porcelain"), "");

  writeFileSync(path.join(root, "tasks", "add-dark-mode", "brief.md"), "mine\n");
  const again = dev(root, ["task", "start", "Add dark mode!"]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already there and left as it was/);
  assert.equal(readFileSync(path.join(root, "tasks", "add-dark-mode", "brief.md"), "utf8"), "mine\n");
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

test("task commands need a clone", () => {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  dev(root, ["init", "--versioning", "example:code", "--repo", "acme/web", "--no-clone"]);
  const { code, err } = dev(root, ["task", "start", "x"]);
  assert.equal(code, 1);
  assert.match(err, /no code clone in repository\/\.\nFix: Run "dev init"/);
});
