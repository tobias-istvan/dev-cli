/** The task record: entry formats, the parser, and what `dev task status` and `dev doctor` make of a record. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { CHANGES, DECISIONS, FINDINGS, LOGS, parseLog, renderEntry, VERIFICATION } from "../src/core/record.ts";
import { TASK_SKILLS } from "../src/core/scaffold.ts";
import { splitFrontMatter } from "../src/core/front-matter.ts";

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
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-record-")));
  const seed = path.join(base, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "--quiet", "--initial-branch=main");
  git(seed, "config", "user.email", "t@example.test");
  git(seed, "config", "user.name", "T");
  writeFileSync(path.join(seed, "README.md"), "code\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "start");
  origin = path.join(base, "origin.git");
  git(base, "clone", "--quiet", "--bare", seed, origin);
});

after(() => rmSync(base, { recursive: true, force: true }));

function dev(cwd: string, args: string[], input?: unknown, extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), DEV_EXTRA_PLUGINS: PLUGIN, DEV_EXAMPLE_TOKEN: "good", ...extra },
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function workspace(): string {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  const init = dev(root, ["init", "--versioning", "example:code", "--repo", "acme/web", "--clone-url", origin, "--service", "notes"]);
  assert.equal(init.code, 0, init.err);
  return root;
}

const RECORD = {
  "findings.md": `# Findings

## F1 · conflict · open

- Sources: jira/ABC-123/ticket.md (Acceptance criteria), figma/abc/design.md
- Blocks: yes
- Answer from: the ticket's reporter

The ticket sorts by date; the design sorts by name.

## F2 · gap · answered

- Blocks: no
- Answer: empty lists show a message, says the reporter

## F3 · missing · assumed

- Blocks: no

## F4 · gap · open

- Blocks: maybe
`,
  "decisions.md": `# Decisions

## D1

- Resolves: F3
- Why: the API already pages

## D2

- Resolves: F9
`,
  "verification.md": `# Verification

## V1 · The list sorts by date · passed

- How: unit test
- Evidence: [evidence/sort.txt](evidence/sort.txt)

## V2 · Empty lists show a message · failed

## V3 · Looks like the design · needs-person

## V4 · Paging still works · planned
`,
  "changes.md": `# Source changes

## C1 · atlassian:jira · reviewed

- Led to: F2

## C2 · atlassian:jira · reviewed

## C3 · atlassian:jira · new

- Changed: status: To Do → In Progress
`,
  "follow-ups.md": `# Follow-ups

## O1 · noted

## O2 · filed

- Filed as: acme/web#12
`,
};

function writeRecord(root: string, id: string, brief: string, files: Record<string, string> = RECORD): void {
  const dir = path.join(root, "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "brief.md"), brief);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
}

const BRIEF = (id: string) => `---
id: "${id}"
title: "Sort the order list"
branch: "feature/${id}-sort"
base: "main"
worktree: "worktrees/${id}"
round: 2
pr: 42
sources:
  - confluence/DOCS/Ordering/index.md
---

# Sort the order list
`;

test("the parser reads entries, fields and text, and warns about what's malformed", () => {
  const { entries, warnings } = parseLog(FINDINGS, RECORD["findings.md"]);
  assert.deepEqual(entries.map((e) => [e.id, e.kind, e.status]), [["F1", "conflict", "open"], ["F2", "gap", "answered"], ["F3", "missing", "assumed"], ["F4", "gap", "open"]]);
  assert.deepEqual(entries[0]!.fields[1], ["Blocks", "yes"]);
  assert.equal(entries[0]!.text, "The ticket sorts by date; the design sorts by name.");
  assert.deepEqual(warnings, [{ line: 20, message: 'F4: Blocks is "maybe", not yes or no' }]);

  const bad = parseLog(FINDINGS, "# Findings\n\n## Notes\n\n## F1 · idea · opne\n\n## F1 · gap\n\n```\n## F9 · not a heading\n```\n");
  assert.deepEqual(bad.warnings.map((w) => w.message), [
    '"## Notes" isn\'t an entry: entries start "## F<n> · <kind> · <status>"',
    'F1: unknown status "opne", not one of open, answered, assumed',
    'F1: unknown kind "idea", not one of gap, conflict, missing',
    'F1: unknown status "gap", not one of open, answered, assumed',
    "F1: no kind (gap: something the sources don't say; conflict: two sources disagree; missing: something referred to isn't there)",
    "F1: F1 is used twice; ids are never reused",
  ]);

  // A free kind can hold anything, " · " included; a log without kinds or statuses takes the id alone.
  assert.equal(parseLog(VERIFICATION, "## V1 · Sorts · then pages · planned\n").entries[0]!.kind, "Sorts · then pages");
  assert.deepEqual(parseLog(DECISIONS, "## D1\n\n## D2 · Sort by date\n").warnings.map((w) => w.message), ['D2: the heading has more than "## D<n>"']);
  assert.deepEqual(parseLog(CHANGES, "## C1 · jira · reviewed\n").warnings.map((w) => w.message), ['C1 is reviewed but has no "- Led to:"']);

  // What dev writes, it reads back.
  const written = renderEntry(CHANGES, { number: 4, kind: "atlassian:jira", status: "new", fields: [["Item", "jira/A-1/ticket.md"]], text: "A-1" });
  assert.deepEqual(parseLog(CHANGES, written), { entries: [{ id: "C4", number: 4, line: 1, kind: "atlassian:jira", status: "new", fields: [["Item", "jira/A-1/ticket.md"]], text: "A-1" }], warnings: [] });
});

test("task status reports a hand-written record, with and without a worktree", () => {
  const root = workspace();
  const started = dev(root, ["task", "start", "ABC-123"]);
  assert.equal(started.code, 0, started.err);
  const brief = readFileSync(path.join(root, "tasks", "ABC-123", "brief.md"), "utf8");
  assert.match(brief, /\nround: 1\nsources: \[\] #/, "a new brief records the round and a place for sources");
  assert.match(brief, /Run the `task-understand` skill/);
  assert.match(brief, /## Record\n[\s\S]*\[findings\.md\]\(findings\.md\)/);
  assert.ok(!brief.includes("## Open questions"), "questions go in findings.md now");
  assert.match(started.out, /next, run the task-understand skill for ABC-123/);
  writeRecord(root, "ABC-123", BRIEF("ABC-123"));

  const status = dev(root, ["task", "status", "ABC-123"]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /ABC-123 on feature\/ABC-123/);
  const record = status.out.slice(status.out.indexOf("Record: tasks/ABC-123/"));
  assert.equal(record, `Record: tasks/ABC-123/
Round 2 · PR #42
Findings: 2 open (F1, F4), 1 blocking (F1), 1 assumed (F3), 1 answered
Decisions: 2
Source changes to review: C3
Verification: 1 of 4 checks passed · failed: V2 · needs a person: V3 · planned: V4
Follow-ups to file: O1
Warnings: 4
  tasks/ABC-123/brief.md  sources lists confluence/DOCS/Ordering/index.md, which isn't in the workspace
  tasks/ABC-123/findings.md:20  F4: Blocks is "maybe", not yes or no
  tasks/ABC-123/changes.md:7  C2 is reviewed but has no "- Led to:"
  tasks/ABC-123/decisions.md:8  D2: Resolves names F9, which isn't in the record
`);

  const json = JSON.parse(dev(root, ["task", "status", "ABC-123", "--json"]).out);
  assert.equal(json.worktree.branch, git(path.join(root, "worktrees", "ABC-123"), "rev-parse", "--abbrev-ref", "HEAD"));
  assert.deepEqual(json.record.blocking, ["F1"]);
  assert.deepEqual(json.record.logs.verification.byStatus, { passed: ["V1"], failed: ["V2"], "needs-person": ["V3"], planned: ["V4"] });

  const list = dev(root, ["task", "status"]);
  assert.match(list.out, /ABC-123 {2}feature\/\S+ {2}0 commits, 0 uncommitted {2}· round 2 · 1 blocking · 1 change to review · 1 failed · 4 warnings/);
  assert.equal(JSON.parse(dev(root, ["task", "status", "--json"]).out).tasks[0].record.pr, 42);

  // A finished task: its worktree is gone, its record stays.
  writeRecord(root, "DONE-1", BRIEF("DONE-1"), { "changes.md": "# Source changes\n\n## C1 · atlassian:jira · new\n" });
  const done = dev(root, ["task", "status", "DONE-1"]);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^DONE-1: no worktree, only its record\n\nRecord: tasks\/DONE-1\/\nRound 2 · PR #42\nFindings: none yet\nSource changes to review: C1\n/);
  assert.match(dev(root, ["task", "status", "NOPE-1"]).err, /no worktree for NOPE-1, and no tasks\/NOPE-1\//);
});

test("an old brief's open questions and criteria stand in until the logs exist", () => {
  const root = workspace();
  writeRecord(root, "OLD-1", `---
id: "OLD-1"
title: "Old"
branch: "feature/OLD-1-old"
worktree: "worktrees/OLD-1"
---

# Old

## Acceptance criteria

- [x] Sorts by date
- [ ] Shows a message when empty

## Open questions

_Anything that needs a person's answer. If one blocks the work, stop and ask._

- Which date: created or updated?
`, {});
  const status = dev(root, ["task", "status", "OLD-1"]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /Round 1\nOpen questions in the brief, from before findings\.md: 1\n {2}Which date: created or updated\?\nVerification: no plan yet \(the brief lists 2 criteria, 1 ticked\)\n$/);
});

test("doctor warns about malformed record entries without failing", () => {
  const root = workspace();
  const clean = dev(root, ["doctor", "--offline"]);
  writeRecord(root, "ABC-9", BRIEF("ABC-9").replace("round: 2", "round: two"), { "follow-ups.md": "# Follow-ups\n\n## O1 · filed\n" });
  const report = dev(root, ["doctor", "--offline"]);
  assert.equal(report.code, clean.code, "warnings don't change the exit code");
  assert.match(report.err, /3 task record warnings, from entries that don't follow the format:\n {2}tasks\/ABC-9\/brief\.md {2}round is "two", not a whole number from 1\n {2}tasks\/ABC-9\/brief\.md {2}sources lists confluence\/DOCS\/Ordering\/index\.md, which isn't in the workspace\n {2}tasks\/ABC-9\/follow-ups\.md:3 {2}O1 is filed but has no "- Filed as:"/);
});

test("the task skills are generated with the record's formats and the workspace's checks", () => {
  const root = workspace();
  assert.equal(dev(root, ["files"]).code, 0);
  const help = new Map<string, boolean>();
  for (const name of TASK_SKILLS) {
    const text = readFileSync(path.join(root, ".claude", "skills", name, "SKILL.md"), "utf8");
    for (const folder of [".github/skills", ".agents/skills"]) assert.equal(readFileSync(path.join(root, folder, name, "SKILL.md"), "utf8"), text);
    assert.match(text, /^Paths are from the workspace root/m, `${name} says where its paths start`);
    assert.ok(!text.includes("{{"), `${name}: every placeholder is filled`);
    assert.match(text, /dev task status <id>/, `${name} starts from the record's state`);
    assert.match(text, /stop/i, `${name} ends by stopping`);

    // Each example is in the format the parser reads.
    for (const [, example] of text.matchAll(/```markdown\n([\s\S]*?)```/g)) {
      const format = LOGS.find((f) => example!.startsWith(`## ${f.prefix}`))!;
      assert.ok(format, `${name}: an example names its log`);
      assert.deepEqual(parseLog(format, example!).warnings, [], `${name}: the ${format.file} example parses`);
    }
    // Every command it mentions exists.
    for (const [, command] of text.matchAll(/`dev ([a-z]+(?: [a-z]+)?)/g)) {
      if (!help.has(command!)) help.set(command!, dev(root, [...command!.split(" "), "--help"]).code === 0);
      assert.ok(help.get(command!), `${name} mentions "dev ${command}", which exists`);
    }
  }
  // Every generated skill's front matter is YAML a strict parser reads, colons and all.
  for (const folder of [".github/skills", ".claude/skills", ".agents/skills"]) {
    for (const name of readdirSync(path.join(root, folder))) {
      const { data } = splitFrontMatter(readFileSync(path.join(root, folder, name, "SKILL.md"), "utf8"));
      assert.equal(data?.name, name, `${folder}/${name} parses`);
      assert.ok(typeof data?.description === "string" && data.description.length > 20, `${folder}/${name} has a description`);
    }
  }

  const understand = readFileSync(path.join(root, ".claude", "skills", "task-understand", "SKILL.md"), "utf8");
  assert.match(understand, /\*\*`findings\.md`\*\*: Gaps, conflicts/);
  assert.match(understand, /- Status: `open`, `answered`, `assumed`/);
  assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /`\.github\/skills\/task-verify\/SKILL\.md` \| Check a task's work/);

  const verify = () => readFileSync(path.join(root, ".claude", "skills", "task-verify", "SKILL.md"), "utf8");
  assert.match(verify(), /suggest naming them in `dev\.yaml` under `conventions\.checks`/);
  writeFileSync(path.join(root, "dev.yaml"), `${readFileSync(path.join(root, "dev.yaml"), "utf8")}conventions:\n  checks:\n    test: npm test\n    lint: npm run lint\n`);
  assert.equal(dev(root, ["files"]).code, 0);
  assert.match(verify(), /From `dev\.yaml`'s `conventions\.checks`, run in `worktrees\/<id>\/`:\n\n {3}- test: `npm test`\n {3}- lint: `npm run lint`/);

  writeFileSync(path.join(root, "dev.yaml"), readFileSync(path.join(root, "dev.yaml"), "utf8").replace("test: npm test", "test: [npm, test]"));
  assert.match(dev(root, ["doctor", "--offline"]).out, /"conventions\.checks" should name each check and its command/);
});

test("session start and the snapshot say what needs action in each record", () => {
  const root = workspace();
  assert.equal(dev(root, ["task", "start", "ABC-123"]).code, 0);
  writeRecord(root, "ABC-123", BRIEF("ABC-123"));
  writeFileSync(path.join(root, "worktrees", "ABC-123", "sort.ts"), "// work in progress\n");
  writeRecord(root, "DONE-1", BRIEF("DONE-1"), { "changes.md": "# Source changes\n\n## C1 · atlassian:jira · new\n\n## C2 · atlassian:jira · new\n" });
  writeRecord(root, "DONE-2", BRIEF("DONE-2"), { "changes.md": "# Source changes\n\n## C1 · atlassian:jira · reviewed\n\n- Led to: nothing\n" });


  const day = dev(root, ["day", "start"]);
  assert.equal(day.code, 0, day.err);
  const snapshot = readFileSync(path.join(root, "snapshot.md"), "utf8");
  assert.match(snapshot, /- \[ABC-123\]\(tasks\/ABC-123\/brief\.md\) on `[^`]+` · 0 commits, 1 uncommitted, round 2, 1 blocking, 1 change to review, 1 failed, 4 warnings/);
  assert.match(snapshot, /Finished tasks whose sources changed: \[DONE-1\]\(tasks\/DONE-1\/changes\.md\) \(C1, C2\)\./);
  assert.ok(!snapshot.includes("DONE-2"), "a finished task with nothing new isn't mentioned");

  // With the snapshot fresh, session start doesn't refresh it in the background.
  const start = dev(root, ["hook", "session-start", "--tool", "claude"], { session_id: "s-1", cwd: root }, { CLAUDE_PROJECT_DIR: root });
  assert.equal(start.code, 0, start.err);
  const context: string = JSON.parse(start.out).hookSpecificOutput.additionalContext;
  assert.match(context, /\nABC-123: 1 source change to review \(C3\), with task-changes, 1 blocking finding \(F1\)\./);
  assert.doesNotMatch(context, /refreshing it in the background/);
});

test("a task's worktree carries the skills, and dev files keeps dev's copies current", () => {
  const root = workspace();
  assert.equal(dev(root, ["task", "start", "ABC-123"]).code, 0);
  const worktree = path.join(root, "worktrees", "ABC-123");
  for (const folder of [".github/skills", ".claude/skills", ".agents/skills"]) {
    for (const name of ["dev-cli", ...TASK_SKILLS]) {
      assert.equal(readFileSync(path.join(worktree, folder, name, "SKILL.md"), "utf8"), readFileSync(path.join(root, folder, name, "SKILL.md"), "utf8"), `${folder}/${name}`);
    }
  }
  assert.equal(git(worktree, "status", "--porcelain"), "", "git ignores the copies, so they can't be committed");

  // The workspace's skills change: dev's copies follow; a file of the person's own doesn't.
  writeFileSync(path.join(worktree, "notes.md"), "mine\n");
  writeFileSync(path.join(root, "dev.yaml"), `${readFileSync(path.join(root, "dev.yaml"), "utf8")}conventions:\n  checks:\n    test: npm test\n`);
  const files = dev(root, ["files"]);
  assert.equal(files.code, 0, files.err);
  assert.match(files.out, /Updated the agent files in worktrees\/ABC-123\./);
  assert.match(readFileSync(path.join(worktree, ".claude", "skills", "task-verify", "SKILL.md"), "utf8"), /- test: `npm test`/);
  assert.equal(readFileSync(path.join(worktree, "notes.md"), "utf8"), "mine\n");
  assert.doesNotMatch(dev(root, ["files"]).out, /Updated the agent files/, "nothing to update the second time");
});

test("task diff shows everything since the branch left its base, from the remote's copy of it", () => {
  const root = workspace();
  // A base that exists only on the remote, as a clone that never checked out develop has it.
  const repo = path.join(root, "repository");
  git(repo, "push", "--quiet", "origin", "main:develop");
  git(repo, "fetch", "--quiet", "origin");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/develop"], { cwd: repo }).status, 1);
  assert.equal(dev(root, ["task", "start", "ABC-7", "--base", "develop"]).code, 0);

  const worktree = path.join(root, "worktrees", "ABC-7");
  git(worktree, "config", "user.email", "t@example.test");
  git(worktree, "config", "user.name", "T");
  writeFileSync(path.join(worktree, "README.md"), "code\ncommitted\n");
  git(worktree, "commit", "--quiet", "-am", "Committed work");
  writeFileSync(path.join(worktree, "README.md"), "code\ncommitted\nuncommitted\n");
  writeFileSync(path.join(worktree, "sort.ts"), "export {};\n");

  const diff = dev(root, ["task", "diff", "ABC-7"]);
  assert.equal(diff.code, 0, diff.err);
  assert.match(diff.out, /^ABC-7: changes since the branch left origin\/develop \([0-9a-f]{7}\), committed or not\./);
  assert.match(diff.out, /\n\+committed\n\+uncommitted\n/);
  assert.match(diff.out, /New files git doesn't track yet, so not in the diff\. Read them directly:\n {2}worktrees\/ABC-7\/sort\.ts\n$/);
  assert.doesNotMatch(diff.out, /SKILL\.md/, "dev's own copies aren't the task's work");
  assert.match(dev(root, ["task", "diff", "ABC-7", "--stat"]).out, /README\.md \| 2 \+\+/);
  assert.match(dev(root, ["task", "diff", "NOPE"]).err, /no worktree for NOPE/);
});
