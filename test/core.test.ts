/**
 * Tests for the core. Each runs in a temporary folder with a temporary config home, and
 * uses the example plugin, so nothing reaches a real service or real credentials.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { listAccounts, loadCredentials, looseWarning, removeCredentials, saveCredentials } from "../src/core/credentials.ts";
import { missingFields, renderItem, splitFrontMatter } from "../src/core/front-matter.ts";
import { buildIndex } from "../src/core/indexes.ts";
import { parseConfig, saveConfig } from "../src/core/project-config.ts";
import { Registry } from "../src/plugins/registry.ts";
import type { Plugin } from "../src/plugins/types.ts";
import example from "./fixtures/example-plugin.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGIN = path.join(import.meta.dirname, "fixtures", "example-plugin.ts");

let base: string;
let outside: string;

before(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-test-")));
  outside = path.join(base, "outside");
  mkdirSync(outside);
});

after(() => rmSync(base, { recursive: true, force: true }));

function configHome(): string {
  return realpathSync(mkdtempSync(path.join(base, "config-")));
}

function dev(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? configHome(),
      DEV_EXTRA_PLUGINS: PLUGIN,
      ...env,
    },
    timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const CONFIG = `# Team workspace
version: 1
versioning:
  service: example:code
  repo: acme/web
services:
  - service: example:notes
    scope:
      book: team # the shared book
`;

function workspace(config = CONFIG): string {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  writeFileSync(path.join(root, "dev.yaml"), config);
  return root;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

// ---------------------------------------------------------------------------
// Commands

test("--help works for every command outside a workspace and writes nothing", () => {
  const commands = [[], ["doctor"], ["files"], ["index"], ["notes"], ["notes", "list"], ["notes", "post"], ["boards", "show"]];
  for (const args of commands) {
    const { code, out, err } = dev(outside, [...args, "--help"]);
    assert.equal(code, 0, `dev ${args.join(" ")} --help: ${err}`);
    assert.match(out, /Usage:/);
  }
  assert.deepEqual(allFiles(outside), []);

  assert.match(dev(outside, ["notes", "post", "--help"]).out, /changes things in Example notes/);
  assert.match(dev(outside, ["notes", "list", "--help"]).out, /only reads/);
});

test("outside a workspace, commands fail clearly and write nothing", () => {
  for (const args of [["doctor"], ["files"], ["index"], ["notes", "list"]]) {
    const { code, err } = dev(outside, args);
    assert.equal(code, 1, args.join(" "));
    assert.match(err, /isn't a dev workspace/);
    assert.match(err, /Fix: .*dev init/);
  }
  assert.deepEqual(allFiles(outside), []);
});

test("commands find the workspace from a subfolder", () => {
  const root = workspace();
  const sub = path.join(root, "a", "b");
  mkdirSync(sub, { recursive: true });
  const { code, out, err } = dev(sub, ["notes", "list"]);
  assert.equal(code, 0, err);
  assert.equal(out.trim(), `book=team folder=${path.join(root, "notes")}`);
});

test("a service's commands run only when it's enabled, with its scope and options", () => {
  const root = workspace();
  const home = configHome();

  const disabled = dev(root, ["boards", "show"]);
  assert.equal(disabled.code, 1);
  assert.match(disabled.err, /isn't enabled.*\n.*dev add boards/);

  mkdirSync(path.join(root, "notes"));
  const loggedOut = dev(root, ["notes", "post", "hello"], { XDG_CONFIG_HOME: home });
  assert.equal(loggedOut.code, 1);
  assert.match(loggedOut.err, /not logged in to Example/);
  assert.match(loggedOut.err, /dev login example/);

  const posted = dev(root, ["notes", "post", "hello", "--pin"], { XDG_CONFIG_HOME: home, DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(posted.code, 0, posted.err);
  assert.equal(readFileSync(path.join(root, "notes", "posted.txt"), "utf8"), "hello pin=true");
});

test("an unknown command fails with a pointer to --help", () => {
  const { code, err } = dev(outside, ["sync-everything"]);
  assert.notEqual(code, 0);
  assert.match(err, /unknown command/);
  assert.match(err, /--help/);
});

// ---------------------------------------------------------------------------
// dev.yaml

test("dev.yaml's problems are all listed, each with what's wrong", () => {
  const good = parseConfig(CONFIG);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.config.versioning, { service: "example:code", repo: "acme/web" });
  assert.deepEqual(good.config.services, [{ service: "example:notes", scope: { book: "team" } }]);

  const bad = parseConfig(`
version: 2
colour: blue
versioning: { service: github }
services:
  - service: Jira
  - service: example:notes
  - service: example:notes
  - service: example:boards
    scope: [1, 2]
conventions: { branch: "feature/x" }
`);
  const messages = bad.problems.map((p) => p.message).join("\n");
  for (const expected of [/version 2/, /unknown key "colour"/, /"versioning" needs a "service" and a "repo"/, /plugin:service, not "Jira"/, /listed twice/, /scope should be a set of keys/, /containing \{id\}/]) {
    assert.match(messages, expected);
  }

  assert.match(parseConfig("version: [").problems[0]?.message ?? "", /isn't valid YAML/);
  assert.match(parseConfig("").problems[0]?.message ?? "", /empty/);
});

test("saving dev.yaml keeps its comments", () => {
  const root = workspace();
  const { config } = parseConfig(CONFIG);
  config.services.push({ service: "example:boards", scope: {} });
  saveConfig(root, config);

  const text = readFileSync(path.join(root, "dev.yaml"), "utf8");
  assert.match(text, /# Team workspace/);
  assert.match(text, /# the shared book/);
  assert.deepEqual(parseConfig(text).config.services.map((s) => s.service), ["example:notes", "example:boards"]);
});

// ---------------------------------------------------------------------------
// Credentials

test("credentials are stored per plugin, readable only by the owner, and the environment overrides them", () => {
  const home = configHome();
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;

  try {
    assert.equal(loadCredentials("example"), null);
    saveCredentials("example", "tester", { token: "stored" });
    saveCredentials("example", "other", { token: "second" });

    const dir = path.join(home, "dev", "credentials");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(dir, "example.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["example.json"]);

    assert.deepEqual(loadCredentials("example"), { account: "other", credentials: { token: "second" } });
    assert.deepEqual(listAccounts("example"), { default: "other", accounts: ["tester", "other"] });

    process.env.DEV_EXAMPLE_TOKEN = "from-env";
    assert.equal(loadCredentials("example")?.credentials.token, "from-env");
    delete process.env.DEV_EXAMPLE_TOKEN;
    process.env.DEV_EXAMPLE_API_URL = "http://localhost:1";
    assert.equal(loadCredentials("example")?.credentials.api_url, undefined, "an address setting isn't a credential");
    delete process.env.DEV_EXAMPLE_API_URL;

    assert.equal(looseWarning("example"), null);
    chmodSync(path.join(dir, "example.json"), 0o644);
    const warning = looseWarning("example") ?? "";
    assert.match(warning, /chmod 600/);
    assert.ok(!warning.includes("second"), "the warning shows no values");

    assert.equal(removeCredentials("example", "other"), true);
    assert.equal(loadCredentials("example")?.account, "tester");
    assert.equal(removeCredentials("example"), true);
    assert.equal(loadCredentials("example"), null);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

// ---------------------------------------------------------------------------
// Plugins

test("the registry finds services by key or id, and reports plugin mistakes", () => {
  const registry = new Registry([example]);
  assert.equal(registry.service("example:notes")?.service.title, "Example notes");
  assert.equal(registry.service("notes")?.key, "example:notes");
  assert.deepEqual(registry.problems(), []);

  const broken: Plugin = {
    ...example,
    name: "Broken",
    services: [{ ...example.services[1]!, id: "notes" }, { ...example.services[0]!, id: "code2", versioning: undefined }],
  };
  const messages = new Registry([example, broken]).problems().map((p) => p.message).join("\n");
  assert.match(messages, /"Broken" must be lowercase/);
  assert.match(messages, /"notes" is used by both example and Broken/);
  assert.match(messages, /versioning service without the versioning capability/);
});

// ---------------------------------------------------------------------------
// Front matter and indexes

test("front matter keeps the common fields first, and missing ones are named", () => {
  const text = renderItem(
    { id: "N-1", title: "First", service: "example:notes", url: "https://x.test/1", updated: "2026-11-01", synced: "2026-11-08T10:00:00Z", status: "Open", colour: "blue" },
    "Body text",
  );
  assert.match(text, /^---\nid: N-1\ntitle: First\nservice: example:notes\n/);
  assert.match(text, /status: Open\ncolour: blue\n---\n\nBody text\n$/);

  const { data, body } = splitFrontMatter(text);
  assert.deepEqual(missingFields(data), []);
  assert.equal(body.trim(), "Body text");
  assert.deepEqual(missingFields({ id: "x", title: "" }), ["title", "service", "url", "updated", "synced"]);
  assert.equal(splitFrontMatter("No front matter").data, null);
});

test("an index lists every item newest first, and names files it skipped", () => {
  const folder = mkdtempSync(path.join(base, "notes-"));
  const item = (id: string, title: string, updated: string) =>
    renderItem({ id, title, service: "example:notes", url: `https://x.test/${id}`, updated, synced: "2026-11-08" }, "text");

  mkdirSync(path.join(folder, "deep", "er"), { recursive: true });
  mkdirSync(path.join(folder, ".staging"));
  writeFileSync(path.join(folder, "a.md"), item("N-1", "Older | with pipe", "2026-10-01"));
  writeFileSync(path.join(folder, "deep", "er", "b c.md"), item("N-2", "Newer", "2026-11-05"));
  writeFileSync(path.join(folder, ".staging", "x.md"), item("N-9", "Half written", "2026-11-07"));
  writeFileSync(path.join(folder, "loose.md"), "# No front matter");

  const result = buildIndex(folder, "Example notes");
  assert.equal(result.items, 2);
  assert.deepEqual(result.skipped, [{ file: "loose.md", missing: ["id", "title", "service", "url", "updated", "synced"] }]);

  const index = readFileSync(path.join(folder, "index.md"), "utf8");
  assert.match(index, /^# Example notes\n/);
  const rows = index.split("\n").filter((line) => line.startsWith("| ["));
  assert.deepEqual(rows, [
    "| [N-2](deep/er/b%20c.md) | Newer |  | 2026-11-05 |",
    "| [N-1](a.md) | Older \\| with pipe |  | 2026-10-01 |",
  ]);
});

test("dev index rebuilds each enabled service's index", () => {
  const root = workspace();
  mkdirSync(path.join(root, "notes"));
  writeFileSync(
    path.join(root, "notes", "n.md"),
    renderItem({ id: "N-1", title: "One", service: "example:notes", url: "u", updated: "2026-11-01", synced: "2026-11-08" }, "x"),
  );
  const { code, out, err } = dev(root, ["index"]);
  assert.equal(code, 0, err);
  assert.match(out, /notes\/index.md: 1 item\./);
  assert.ok(existsSync(path.join(root, "notes", "index.md")));
  assert.match(dev(root, ["index", "boards"]).err, /isn't an enabled service/);
});

// ---------------------------------------------------------------------------
// Generated files

test("dev files writes the agent files for the enabled services only", () => {
  const root = workspace();
  const { code, out, err } = dev(root, ["files"]);
  assert.equal(code, 0, err);
  assert.match(out, /Done: \d+ files changed/);

  const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /`acme\/web`/);
  assert.match(agents, /\| `notes\/` \| Example notes: Team notes/);
  assert.match(agents, /8\. Never post a note unless the person asks\./);
  assert.match(agents, /dev task list --mine/);
  assert.match(agents, /\| `dev notes post <text>` \| Post a note \|/);
  assert.match(agents, /\| `dev doctor` \|/);
  assert.ok(!agents.includes("dev boards"), "a disabled service's commands stay out");
  assert.ok(!agents.includes("{{"), "every placeholder is filled");

  for (const folder of [".github/skills", ".claude/skills", ".agents/skills"]) {
    assert.match(readFileSync(path.join(root, folder, "dev-cli", "SKILL.md"), "utf8"), /^---\nname: "dev-cli"\ndescription: "/);
    assert.match(readFileSync(path.join(root, folder, "example-notes", "SKILL.md"), "utf8"), /Read notes\/index.md first/);
  }
  assert.ok(existsSync(path.join(root, "docs", "example-notes.md")));
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")), { mcpServers: { example: { command: "example-mcp" } } });
  assert.ok(existsSync(path.join(root, "CLAUDE.md")));
  for (const folder of ["tasks", "worktrees", "notes"]) assert.ok(existsSync(path.join(root, folder)), folder);

  const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /repository\/\nworktrees\/\n\.dev\/state\/\nnotes\/\.cache\//);

  assert.match(dev(root, ["files"]).out, /already up to date/);
});

test("dev files updates its own files, leaves edited ones alone, and removes what no longer applies", () => {
  const root = workspace();
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  dev(root, ["files"]);

  // Someone edits CLAUDE.md, then the notes service is swapped for boards.
  writeFileSync(path.join(root, "CLAUDE.md"), "My own instructions\n");
  writeFileSync(path.join(root, "dev.yaml"), CONFIG.replace(/  - service: example:notes\n    scope:\n      book: team # the shared book\n/, "  - service: example:boards\n"));

  const { code, out, err } = dev(root, ["files"]);
  assert.equal(code, 0, err);
  assert.match(out, /Updated:\n(.*\n)*  AGENTS\.md/);
  assert.match(out, /Removed:\n(.*\n)*  \.github\/skills\/example-notes\/SKILL\.md/);
  assert.match(out, /Edited by hand, so left as they are:\n  CLAUDE\.md/);

  assert.equal(readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "My own instructions\n");
  assert.ok(!existsSync(path.join(root, ".claude", "skills", "example-notes", "SKILL.md")));
  assert.ok(!existsSync(path.join(root, ".mcp.json")));
  assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /dev boards show/);

  const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^node_modules\/\n/);
  assert.ok(!gitignore.includes("notes/.cache/"));
  assert.equal(gitignore.match(/# >>> dev/g)?.length, 1);
});

// ---------------------------------------------------------------------------
// Doctor

test("doctor lists each problem with a fix, and passes once they're fixed", () => {
  const root = workspace(CONFIG.replace("book: team # the shared book", "shelf: 3"));
  const home = configHome();

  const first = dev(root, ["doctor"], { XDG_CONFIG_HOME: home });
  assert.equal(first.code, 1);
  assert.match(first.out, /example:notes scope: needs a "book"\.\n  Fix: Add book/);
  assert.match(first.out, /not logged in to Example\.\n  Fix: Run "dev login example" yourself/);
  assert.match(first.out, /Generated files are missing or out of date.*\n  Fix: Run "dev files"/);

  writeFileSync(path.join(root, "dev.yaml"), CONFIG);
  dev(root, ["files"], { XDG_CONFIG_HOME: home });

  const rejected = dev(root, ["doctor"], { XDG_CONFIG_HOME: home, DEV_EXAMPLE_TOKEN: "bad" });
  assert.equal(rejected.code, 1);
  assert.match(rejected.out, /Example rejected the token/);

  const offline = dev(root, ["doctor", "--offline"], { XDG_CONFIG_HOME: home, DEV_EXAMPLE_TOKEN: "bad" });
  assert.equal(offline.code, 0, offline.out);

  const good = dev(root, ["doctor"], { XDG_CONFIG_HOME: home, DEV_EXAMPLE_TOKEN: "good" });
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /Example: logged in as tester\.\nNo problems found\./);
});

test("doctor flags unknown services and services in the wrong place", () => {
  const root = workspace(`version: 1
versioning: { service: example:notes, repo: acme/web }
services:
  - service: example:code
  - service: nobody:here
`);
  const { code, out } = dev(root, ["doctor", "--offline"]);
  assert.equal(code, 1);
  assert.match(out, /example:notes isn't a versioning service/);
  assert.match(out, /example:code is a versioning service, so it belongs under "versioning"/);
  assert.match(out, /Unknown service "nobody:here"/);
});

test("pickers match fuzzily and rank the closest first", async () => {
  const { fuzzyScore, rank } = await import("../src/core/prompt.ts");
  const spaces = [
    { name: "Marketing Site", description: "MKT" },
    { name: "Design System", description: "DS" },
    { name: "Product Design Docs", description: "PDD" },
    { name: "Platform", description: "PLAT" },
  ];
  assert.deepEqual(rank("design", spaces).map((s) => s.name), ["Design System", "Product Design Docs"]);
  assert.deepEqual(rank("dsgn sys", spaces).map((s) => s.name), ["Design System"]);
  assert.deepEqual(rank("plat", spaces).map((s) => s.name)[0], "Platform");
  assert.deepEqual(rank("mkt", spaces).map((s) => s.name), ["Marketing Site"], "the key counts too");
  assert.deepEqual(rank("", spaces), spaces, "an empty search keeps the order");
  assert.equal(fuzzyScore("xyz", "Design System"), null);
});
