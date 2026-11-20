/** Change records: what a sync changed, and which tasks it affects, against items a test plugin mirrors from a folder. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { compareItem, readItem } from "../src/core/changes.ts";
import { CHANGES, nextNumber, renderEntry } from "../src/core/record.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGINS = [path.join(import.meta.dirname, "fixtures", "example-plugin.ts"), path.join(import.meta.dirname, "fixtures", "recorded-plugin.ts")].join(":");
const today = new Date().toLocaleDateString("en-CA");

let base: string;
let origin: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

before(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-changes-")));
  const seed = path.join(base, "seed");
  git(base, "init", "--quiet", "--initial-branch=main", seed);
  git(seed, "config", "user.email", "t@example.test");
  git(seed, "config", "user.name", "T");
  writeFileSync(path.join(seed, "README.md"), "code\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "start");
  origin = path.join(base, "origin.git");
  git(base, "clone", "--quiet", "--bare", seed, origin);
});

after(() => rmSync(base, { recursive: true, force: true }));

function dev(root: string, remote: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_EXTRA_PLUGINS: PLUGINS, DEV_EXAMPLE_TOKEN: "good", DEV_RECORDED_REMOTE: remote, ...env },
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

interface Fields { id: string; title: string; updated: string; status?: string; parent?: string; url?: string }

/** Writes an item into the fake service, as its API would return it. */
function put(remote: string, file: string, service: string, fields: Fields, body: string): void {
  const target = path.join(remote, file);
  mkdirSync(path.dirname(target), { recursive: true });
  const extra = [fields.status ? `status: ${fields.status}` : "", fields.parent ? `parent: ${fields.parent}` : ""].filter(Boolean);
  writeFileSync(target, [
    "---",
    `id: ${fields.id}`,
    `title: ${fields.title}`,
    `service: ${service}`,
    `url: ${fields.url ?? `https://${service.split(":")[1]}.test/${fields.id}`}`,
    `updated: ${fields.updated}`,
    "synced: 2026-01-01T00:00:00Z",
    ...extra,
    "inScope: true",
    "via: scope",
    "---",
    "",
    body.trim(),
    "",
  ].join("\n"));
}

const ticket = (remote: string, fields: Fields, body: string) => put(remote, `tickets/${fields.id}.md`, "recorded:tickets", fields, body);
const page = (remote: string, file: string, fields: Fields, body: string) => put(remote, `pages/${file}`, "recorded:pages", fields, body);

const T1 = (criteria: string, comments: string[]) => `
# TCK-1: Sort the order list

## Description

Sort the list. The spec: [Ordering](../../pages/ordering/spec.md "https://pages.test/P-1")

## Acceptance criteria

${criteria}

## Comments (${comments.length})

${comments.join("\n\n")}
`;

function setup(): { root: string; remote: string } {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  const remote = path.join(root, "..", `${path.basename(root)}-remote`);
  ticket(remote, { id: "TCK-1", title: "Sort the order list", updated: "2026-11-01T10:00:00Z", status: "In Progress", parent: "TCK-100" }, T1("- Sorted by date", ["**sam**: Looks right."]));
  ticket(remote, { id: "TCK-100", title: "Orders epic", updated: "2026-11-01T09:00:00Z" }, "## Goal\n\nBetter orders.");
  ticket(remote, { id: "TCK-2", title: "Unrelated", updated: "2026-11-01T08:00:00Z", status: "To Do" }, "## Description\n\nSomething else.");
  page(remote, "ordering/spec.md", { id: "P-1", title: "Ordering spec", updated: "2026-11-01T07:00:00Z" }, "## Sorting\n\nBy date, newest first.");
  page(remote, "other.md", { id: "P-2", title: "Other page", updated: "2026-11-01T07:00:00Z" }, "## Text\n\nNothing to do with orders.");

  const init = dev(root, remote, ["init", "--versioning", "example:code", "--repo", "acme/web", "--clone-url", origin, "--service", "tickets", "pages"]);
  assert.equal(init.code, 0, init.err);
  return { root, remote };
}

const read = (root: string, file: string) => readFileSync(path.join(root, file), "utf8");

test("a sync records what changed in the day's report and in each task it affects, with no commit", () => {
  const { root, remote } = setup();
  const first = dev(root, remote, ["sync"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /Changes: this sync set the baseline/);
  assert.ok(existsSync(path.join(root, ".dev", "state", "items.json")));
  assert.ok(!existsSync(path.join(root, "work-sessions", today, "changes.md")), "the first sync records nothing");
  assert.equal(dev(root, remote, ["task", "start", "TCK-1"]).code, 0);

  // Nothing changed in the source: nothing is recorded.
  const quiet = dev(root, remote, ["sync"]);
  assert.equal(quiet.code, 0, quiet.err);
  assert.doesNotMatch(quiet.out, /Changes:/);

  // The ticket moves on, its epic and spec change, another ticket is only rendered differently,
  // a page moves, and a ticket arrives.
  ticket(remote, { id: "TCK-1", title: "Sort the order list", updated: "2026-11-02T10:00:00Z", status: "In Review", parent: "TCK-100" }, T1("- Sorted by name", ["**sam**: Looks right.", "**kim**: By name now.", "**sam**: OK."]));
  ticket(remote, { id: "TCK-100", title: "Orders epic", updated: "2026-11-02T09:00:00Z" }, "## Goal\n\nBetter orders, sooner.");
  ticket(remote, { id: "TCK-2", title: "Unrelated", updated: "2026-11-01T08:00:00Z", status: "To Do" }, "## Description\n\nSomething else, drawn differently.");
  ticket(remote, { id: "TCK-3", title: "New one", updated: "2026-11-02T11:00:00Z" }, "## Description\n\nNew.");
  page(remote, "ordering/spec.md", { id: "P-1", title: "Ordering spec", updated: "2026-11-02T07:00:00Z" }, "## Sorting\n\nBy name.");
  rmSync(path.join(remote, "pages", "other.md"));
  page(remote, "archive/other.md", { id: "P-2", title: "Other page", updated: "2026-11-01T07:00:00Z" }, "## Text\n\nNothing to do with orders.");

  const synced = dev(root, remote, ["sync"]);
  assert.equal(synced.code, 0, synced.err);
  assert.match(synced.out, new RegExp(`Changes: 5 items, affecting TCK-1\\. See work-sessions/${today}/changes\\.md\\.`));
  assert.equal(git(path.join(root, "repository"), "status", "--porcelain"), "", "nothing was committed or staged anywhere");

  const report = read(root, `work-sessions/${today}/changes.md`);
  assert.match(report, new RegExp(`^# Source changes · ${today}\n`));
  assert.match(report, /\n## \d\d:\d\d · Recorded tickets, Recorded pages\n/);
  assert.match(report, /- \[P-2\]\(\.\.\/\.\.\/pages\/archive\/other\.md\) · recorded:pages · Other page\n {2}- moved from pages\/other\.md\n/);
  assert.match(report, /- \[P-1\]\(\.\.\/\.\.\/pages\/ordering\/spec\.md\) · recorded:pages · Ordering spec\n {2}- section changed: Sorting\n {2}- Affects: \[TCK-1\]\(\.\.\/\.\.\/tasks\/TCK-1\/changes\.md\) \(C\d\)\n/);
  assert.match(report, /- \[TCK-1\]\(\.\.\/\.\.\/tickets\/TCK-1\/ticket\.md\) · recorded:tickets · Sort the order list\n {2}- 2 comments added\n {2}- status: In Progress → In Review\n {2}- section changed: Acceptance criteria\n {2}- Affects: \[TCK-1\]/);
  assert.match(report, /- \[TCK-100\].*\n {2}- section changed: Goal\n {2}- Affects: \[TCK-1\]/, "the parent is a source");
  assert.match(report, /- \[TCK-3\].*\n {2}- added\n/);
  assert.doesNotMatch(report, /TCK-2/, "the same updated, rendered differently, isn't a change");
  assert.doesNotMatch(report, /section changed: Description/, "a link pointed at the local copy isn't a change");

  const log = read(root, "tasks/TCK-1/changes.md");
  assert.match(log, /^# Source changes\n\nWritten by `dev sync`/);
  assert.match(log, /\n## C1 · recorded:pages · new\n\n- Item: \[pages\/ordering\/spec\.md\]\(\.\.\/\.\.\/pages\/ordering\/spec\.md\)\n- Changed: section changed: Sorting\n- Report: \[work-sessions\/[\d-]+\/changes\.md\]\(\.\.\/\.\.\/work-sessions\/[\d-]+\/changes\.md\)\n- Recorded: [\d-]+ \d\d:\d\d\n\nP-1 · Ordering spec\n/);
  assert.match(log, /\n## C2 · recorded:tickets · new\n\n- Item: \[tickets\/TCK-1\/ticket\.md\].*\n- Changed: 2 comments added; status: In Progress → In Review; section changed: Acceptance criteria\n/);
  assert.match(log, /\n## C3 · recorded:tickets · new\n[\s\S]*TCK-100 · Orders epic/);
  assert.ok(!existsSync(path.join(root, "tasks", "TCK-2")));

  // A reviewed entry keeps its id; the next change gets a new one. Leaving the scope is recorded
  // without an updated, and so is a page that's gone.
  writeFileSync(path.join(root, "tasks/TCK-1/changes.md"), log.replace("## C1 · recorded:pages · new", "## C1 · recorded:pages · reviewed").concat("- Led to: nothing\n"));
  rmSync(path.join(remote, "tickets", "TCK-1.md"));
  rmSync(path.join(remote, "pages", "archive"), { recursive: true });
  const later = dev(root, remote, ["sync"]);
  assert.match(later.out, /Changes: 2 items, affecting TCK-1\./);
  const again = read(root, "tasks/TCK-1/changes.md");
  assert.match(again, /## C1 · recorded:pages · reviewed/);
  assert.match(again, /\n## C4 · recorded:tickets · new\n\n- Item: \[tickets\/TCK-1\/ticket\.md\].*\n- Changed: left the scope\n/);
  assert.match(read(root, `work-sessions/${today}/changes.md`), /- \[P-2\]\(\.\.\/\.\.\/pages\/archive\/other\.md\) · recorded:pages · Other page\n {2}- no longer in the workspace\n/);
  assert.equal((read(root, `work-sessions/${today}/changes.md`).match(/^## \d\d:\d\d/gm) ?? []).length, 2, "one section per sync that changed something");

  // The day summary links the report.
  const end = dev(root, remote, ["day", "end"]);
  assert.equal(end.code, 0, end.err);
  assert.match(read(root, `work-sessions/${today}/summary.md`), /### Source changes\n\nWhat the day's syncs changed, and the tasks it affects: \[changes\.md\]\(changes\.md\)/);
});

test("a sync that's killed before it records loses nothing: the next one compares with the same baseline", () => {
  const { root, remote } = setup();
  assert.equal(dev(root, remote, ["sync"]).code, 0);
  ticket(remote, { id: "TCK-2", title: "Unrelated", updated: "2026-11-03T08:00:00Z", status: "Done" }, "## Description\n\nSomething else.");
  const killed = dev(root, remote, ["sync", "tickets"], { DEV_RECORDED_CRASH: "1" });
  assert.equal(killed.code, 9);
  assert.match(read(root, "tickets/TCK-2/ticket.md"), /status: Done/, "the file was written before the kill");
  const next = dev(root, remote, ["sync"], {});
  assert.equal(next.code, 0, next.err);
  assert.match(next.out, /Changes: 1 item\. See/);
  assert.match(read(root, `work-sessions/${today}/changes.md`), /- \[TCK-2\].*\n {2}- status: To Do → Done\n/);
});

test("a brief's sources: front matter adds what the link graph can't see", () => {
  const { root, remote } = setup();
  assert.equal(dev(root, remote, ["sync"]).code, 0);
  mkdirSync(path.join(root, "tasks", "by-hand"));
  writeFileSync(path.join(root, "tasks", "by-hand", "brief.md"), '---\nid: "by-hand"\nsources:\n  - pages/other.md\n---\n\n# By hand\n');
  page(remote, "other.md", { id: "P-2", title: "Other page", updated: "2026-11-04T07:00:00Z" }, "## Text\n\nNow it matters.");
  const synced = dev(root, remote, ["sync"]);
  assert.match(synced.out, /Changes: 1 item, affecting by-hand\./);
  assert.match(read(root, "tasks/by-hand/changes.md"), /## C1 · recorded:pages · new\n\n- Item: \[pages\/other\.md\]/);
});

test("compareItem follows the updated rule; moves, scope and comments always count", () => {
  const item = (updated: string, status: string, body: string, extra = "") =>
    readItem("t/A-1.md", `---\nid: A-1\ntitle: A\nservice: x:t\nurl: https://x.test/A-1\nupdated: ${updated}\nsynced: 2026-01-01\nstatus: ${status}\ninScope: true\n${extra}---\n\n${body}`)!.state;
  const body = "## Text\n\nHello\n\n## Comments (1)\n\nhi";
  const a = item("2026-11-01", "Open", body);
  assert.deepEqual(compareItem(a, item("2026-11-01", "Open", body)), []);
  assert.deepEqual(compareItem(a, item("2026-11-01", "Closed", "## Text\n\nHi there\n\n## Comments (1)\n\nhi")), [], "same updated: rendering, not a change");
  assert.deepEqual(compareItem(a, item("2026-11-02", "Closed", body)), ["status: Open → Closed"]);
  assert.deepEqual(compareItem(a, item("2026-11-01", "Open", "## Text\n\nHello\n\n## Comments (3)\n\nhi\n\nmore")), ["2 comments added"]);
  assert.deepEqual(compareItem(a, { ...item("2026-11-01", "Open", body), file: "t/old/A-1.md" }), ["moved from t/A-1.md"]);
  assert.deepEqual(compareItem(a, item("2026-11-01", "Open", body, "gone: true\n")), ["deleted in the service"]);
  assert.deepEqual(compareItem(a, { ...a, fields: { ...a.fields, inScope: false, via: "former" } }), ["left the scope"], "via changes with it, and isn't listed on its own");
  assert.deepEqual(compareItem(a, item("2026-11-02", "Open", `${body}\n\n<!-- dev:outside-scope -->\nOutside: https://x.test/Z-9`)), [], "dev's own outside-scope note isn't the source's");
});

test("log entries share one shape, and ids are never reused", () => {
  assert.equal(nextNumber(CHANGES, "# Source changes\n"), 1);
  assert.equal(nextNumber(CHANGES, "## C1 · a · reviewed\n\n## C7 · b · new\n\n## C3 · c · new\n"), 8);
  assert.equal(
    renderEntry(CHANGES, { number: 2, kind: "atlassian:jira", status: "new", fields: [["Item", "jira/A-1/ticket.md"], ["Changed", "status: A → B"]], text: "A-1 · Title" }),
    "## C2 · atlassian:jira · new\n\n- Item: jira/A-1/ticket.md\n- Changed: status: A → B\n\nA-1 · Title",
  );
});
