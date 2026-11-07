/**
 * dev init, login and the GitHub plugin. GitHub is a local fake server and gh is a stub
 * script, so nothing reaches the network or real accounts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseConfig } from "../src/core/project-config.ts";
import github from "../src/plugins/github/index.ts";
import { classifyGh } from "../src/plugins/github/policy.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGIN = path.join(import.meta.dirname, "fixtures", "example-plugin.ts");
const GOOD_TOKEN = "gho_fakeTOKENforTESTS0000000000000000";

let base: string;
let stubs: string;
let server: Server;
let apiUrl: string;
let code: string;

before(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-init-")));
  stubs = path.join(base, "stubs");
  mkdirSync(stubs);

  // gh with two logged-in accounts, and a token only for "me".
  writeFileSync(
    path.join(stubs, "gh"),
    `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  echo "github.com"
  echo "  ✓ Logged in to github.com account me (keyring)"
  echo "  ✓ Logged in to github.com account work (keyring)"
  exit 0
fi
if [ "$1 $2" = "auth token" ]; then
  case "$*" in *"--user me"*) echo "${GOOD_TOKEN}"; exit 0;; esac
  echo "no token" >&2; exit 1
fi
exit 1
`,
  );
  chmodSync(path.join(stubs, "gh"), 0o755);

  server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
      response.writeHead(401).end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/user") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ login: "me" }));
      return;
    }
    if (url.pathname === "/user/repos") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (page === 1) headers.link = `<${apiUrl}/user/repos?per_page=100&page=2>; rel="next"`;
      const repos =
        page === 1
          ? [{ full_name: "me/app", description: "The app", archived: false }, { full_name: "me/old", description: null, archived: true }]
          : [{ full_name: "acme/web", description: null, archived: false }];
      response.writeHead(200, headers).end(JSON.stringify(repos));
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A small local repository for init to clone.
  code = path.join(base, "code");
  mkdirSync(code);
  const git = (...args: string[]) => spawnSync("git", args, { cwd: code });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  writeFileSync(path.join(code, "README.md"), "code\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "start");
});

after(async () => {
  server.close();
  rmSync(base, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("DEV_")) delete clean[key];
  return {
    ...clean,
    PATH: `${stubs}:${process.env.PATH}`,
    XDG_CONFIG_HOME: realpathSync(mkdtempSync(path.join(base, "config-"))),
    DEV_GITHUB_API_URL: apiUrl,
    DEV_EXTRA_PLUGINS: PLUGIN,
    ...extra,
  };
}

function dev(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: env(extra), timeout: 60_000 });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function folder(): string {
  return realpathSync(mkdtempSync(path.join(base, "ws-")));
}

const EXAMPLE = ["--versioning", "example:code", "--repo", "acme/web"];

// ---------------------------------------------------------------------------
// init

test("init sets up a workspace from flags, clones the code, and commits nothing", () => {
  const root = path.join(folder(), "new", "web");
  const { code: exit, out, err } = dev(base, ["init", root, ...EXAMPLE, "--clone-url", code, "--service", "notes"], { DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(exit, 0, err);

  const { config, problems } = parseConfig(readFileSync(path.join(root, "dev.yaml"), "utf8"));
  assert.deepEqual(problems, []);
  assert.deepEqual(config.versioning, { service: "example:code", repo: "acme/web" });
  assert.deepEqual(config.services, [{ service: "example:notes", scope: {} }]);

  assert.ok(existsSync(path.join(root, "repository", "README.md")), "the code is cloned");
  assert.ok(existsSync(path.join(root, "AGENTS.md")));
  assert.ok(existsSync(path.join(root, ".claude", "skills", "example-notes", "SKILL.md")));
  assert.match(out, /Example notes: no scope chosen\. Run "dev notes scope"/);
  assert.match(out, /Done: acme\/web is set up/);
  assert.match(out, /Nothing was committed\./);

  const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
  assert.notEqual(log.status, 0, "the workspace has no commits");
});

test("init is safe to run again, and keeps what dev.yaml says", () => {
  const root = folder();
  dev(root, ["init", ...EXAMPLE, "--clone-url", code], { DEV_EXAMPLE_TOKEN: "good" });
  writeFileSync(path.join(root, "CLAUDE.md"), "Mine\n");

  const again = dev(root, ["init", "--no-clone"], { DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /Versioning: Example code, from dev\.yaml/);
  assert.match(again.out, /Edited by hand, so left as they are:\n  CLAUDE\.md/);
  assert.equal(readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "Mine\n");

  const other = dev(root, ["init", "--repo", "acme/other", "--no-clone"], { DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(other.code, 1);
  assert.match(other.err, /This workspace is for acme\/web/);
});

test("init asks for a flag when there's nobody to answer", () => {
  const root = folder();

  const versioning = dev(root, ["init"], { DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(versioning.code, 1);
  assert.match(versioning.err, /Fix: Pass --versioning <service> instead/);

  const repository = dev(root, ["init", "--versioning", "example:code"], { DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(repository.code, 1);
  assert.match(repository.err, /Fix: Pass --repo <owner\/name> instead/);

  const login = dev(root, ["init", ...EXAMPLE]);
  assert.equal(login.code, 1);
  assert.match(login.err, /needs a person at a terminal/);
  assert.ok(!existsSync(path.join(root, "dev.yaml")), "nothing is written before the questions are answered");
});

test("init refuses to nest a workspace, and names unknown services", () => {
  const root = folder();
  dev(root, ["init", ...EXAMPLE, "--no-clone"], { DEV_EXAMPLE_TOKEN: "good" });
  mkdirSync(path.join(root, "inner"));

  const nested = dev(root, ["init", "inner", ...EXAMPLE], { DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(nested.code, 1);
  assert.match(nested.err, /inside the workspace at/);

  const unknown = dev(folder(), ["init", "--versioning", "notes", "--repo", "x/y"], { DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /"notes" isn't a versioning service\.\nFix: Use one of: github:github, example:code/);
});

test("a failed clone keeps the setup and says how to retry", () => {
  const root = folder();
  const { code: exit, out, err } = dev(root, ["init", ...EXAMPLE, "--clone-url", path.join(base, "missing")], { DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(exit, 1);
  assert.match(err, /The clone failed\. Once that's fixed, retry with: git clone .*missing repository/);
  assert.ok(existsSync(path.join(root, "dev.yaml")));
  assert.match(out, /Done:/);
});

// ---------------------------------------------------------------------------
// login

test("login refuses to run without a person at a terminal", () => {
  const { code: exit, err } = dev(base, ["login", "github"]);
  assert.equal(exit, 1);
  assert.match(err, /needs a person at a terminal/);
  assert.match(err, /DEV_GITHUB_TOKEN/);

  assert.match(dev(base, ["login", "nobody"]).err, /no plugin called "nobody"/);
});

test("logout removes a saved login, and says when there was none", () => {
  const home = realpathSync(mkdtempSync(path.join(base, "config-")));
  mkdirSync(path.join(home, "dev", "credentials"), { recursive: true });
  writeFileSync(path.join(home, "dev", "credentials", "github.json"), JSON.stringify({ default: "me", accounts: { me: { method: "gh", user: "me" } } }), { mode: 0o600 });

  assert.match(dev(base, ["logout", "github"], { XDG_CONFIG_HOME: home }).out, /Removed the saved GitHub login/);
  assert.ok(!existsSync(path.join(home, "dev", "credentials", "github.json")));
  assert.match(dev(base, ["logout", "github"], { XDG_CONFIG_HOME: home }).out, /There was no saved GitHub login/);
});

// ---------------------------------------------------------------------------
// The GitHub plugin

function withApi<T>(run: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.DEV_GITHUB_API_URL, path: process.env.PATH };
  process.env.DEV_GITHUB_API_URL = apiUrl;
  process.env.PATH = `${stubs}:${saved.path}`;
  return run().finally(() => {
    process.env.DEV_GITHUB_API_URL = saved.url;
    process.env.PATH = saved.path;
  });
}

const context = { root: null, out: { info() {}, warn() {} }, interactive: false };

test("a gh login stores the account, never the token", () =>
  withApi(async () => {
    const result = await github.login.login(context, "cli", { account: "me" });
    assert.deepEqual(result, { account: "me", credentials: { method: "gh", user: "me" } });
    assert.ok(!JSON.stringify(result).includes(GOOD_TOKEN));

    await assert.rejects(github.login.login(context, "cli", { account: "stranger" }), /gh has no login for stranger\. It has: me, work/);
    await assert.rejects(github.login.login(context, "cli", { account: "work" }), /gh has no working login for the account work/);
  }));

test("the GitHub login check reports a rejected token with a fix", () =>
  withApi(async () => {
    assert.deepEqual(await github.login.check(context, { method: "gh", user: "me" }), { ok: true, account: "me" });
    const rejected = await github.login.check(context, { method: "token", token: "wrong" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.problem?.message ?? "", /GitHub rejected the saved login/);
    assert.match(rejected.problem?.fix ?? "", /dev login github/);
  }));

test("the repository list follows every page and leaves out archived ones", () =>
  withApi(async () => {
    const service = github.services[0];
    const repositories = await service?.versioning?.listRepositories(context, { method: "gh", user: "me" });
    assert.deepEqual(repositories?.map((r) => r.id), ["me/app", "acme/web"]);
  }));

test("gh help is a read whatever the command, and the token stays secret", () => {
  assert.deepEqual(classifyGh(["auth", "token", "--help"]), { command: "help", kind: "read", why: "help only" });
  assert.equal(classifyGh(["auth", "token"]).command, "auth token");
  assert.equal(classifyGh(["pr", "merge", "1"]).kind, "change");
  assert.equal(classifyGh(["pr", "view", "1"]).kind, "read");
  assert.equal(classifyGh(["co", "1"], { co: "pr checkout" }).kind, "read");
  assert.deepEqual(github.secrets?.({ method: "token", token: "abc" }), ["abc"]);
  assert.deepEqual(github.secrets?.({ method: "gh", user: "me" }), []);
});
