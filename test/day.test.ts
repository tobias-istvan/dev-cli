/** Syncing, the day, sessions, hooks and the command check. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { claudeDir } from "../src/core/sessions/index.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const PLUGIN = path.join(import.meta.dirname, "fixtures", "example-plugin.ts");
const SESSION = "aaaaaaaa-1111-4000-8000-000000000001";

let base: string;
const saved = { claude: process.env.CLAUDE_CONFIG_DIR };
before(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-day-")));
  // Transcripts this test writes must land in its own folder, never the real ~/.claude.
  process.env.CLAUDE_CONFIG_DIR = path.join(base, "claude");
});
after(() => {
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claude;
  rmSync(base, { recursive: true, force: true });
});

function dev(cwd: string, args: string[], options: { input?: object; env?: Record<string, string> } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input: options.input ? JSON.stringify(options.input) : undefined,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(base, "config"),
      CLAUDE_CONFIG_DIR: path.join(base, "claude"),
      COPILOT_HOME: path.join(base, "copilot"),
      DEV_EXTRA_PLUGINS: PLUGIN,
      DEV_EXAMPLE_TOKEN: "averysecretvalue123",
      ...options.env,
    },
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function workspace(book = "team"): string {
  const root = realpathSync(mkdtempSync(path.join(base, "ws-")));
  writeFileSync(path.join(root, "dev.yaml"), `version: 1\nversioning: { service: example:code, repo: acme/web }\nservices:\n  - service: example:notes\n    scope: { book: ${book} }\n`);
  dev(root, ["files"]);
  return root;
}

// ---------------------------------------------------------------------------
// Sync and the day

test("sync runs each service and reports what changed, and a failure is reported but doesn't stop it", () => {
  const root = workspace();
  const ok = dev(root, ["sync"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Example notes: 1 new, 0 updated, 0 removed\.\nDone: synced\./);
  assert.ok(existsSync(path.join(root, "notes", "N-5.md")));

  const broken = dev(workspace("broken"), ["sync"]);
  assert.equal(broken.code, 1);
  assert.match(broken.err, /Example notes: failed\. The book is gone\./);
  assert.match(broken.out, /Done, with failures/);

  assert.match(dev(root, ["sync", "boards"]).err, /isn't an enabled service that syncs/);
});

test("day end keeps what was written, and day start carries the next steps over", () => {
  const root = workspace();
  const end = dev(root, ["day", "end", "--date", "2026-11-07"]);
  assert.equal(end.code, 0, end.err);
  const file = path.join(root, "work-sessions", "2026-11-07", "summary.md");
  let summary = readFileSync(file, "utf8");
  assert.match(summary, /^# 2026-11-07\n/);
  assert.match(summary, /## Next steps\n\n_The very next things to do/);
  assert.match(summary, /### Example notes\n\n- 1 note changed/);

  writeFileSync(file, summary.replace(/## Next steps\n\n_[^\n]*_/, "## Next steps\n\n- Finish the login fix").replace(/## Blocked\n\n_[^\n]*_/, "## Blocked\n\n- Waiting on design"));
  dev(root, ["day", "end", "--date", "2026-11-07"]);
  summary = readFileSync(file, "utf8");
  assert.match(summary, /## Next steps\n\n- Finish the login fix\n/);

  const start = dev(root, ["day", "start", "--no-sync"]);
  assert.equal(start.code, 0, start.err);
  const snapshot = readFileSync(path.join(root, "snapshot.md"), "utf8");
  assert.match(snapshot, /^# Snapshot · \d{4}-\d{2}-\d{2}\n/);
  assert.match(snapshot, /## Carried over from 2026-11-07\n\n- Finish the login fix\n\nStill blocked:\n\n- Waiting on design/);
  assert.match(snapshot, /## Example notes\n\n- N-5 needs an answer/);
});

// ---------------------------------------------------------------------------
// Sessions and hooks

function claudeTranscript(root: string): void {
  const dir = claudeDir(root);
  assert.ok(dir.startsWith(base), "the test transcript stays inside the test folder");
  mkdirSync(dir, { recursive: true });
  const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const lines = [
    { type: "user", sessionId: SESSION, timestamp: at(0), gitBranch: "main", message: { role: "user", content: "Use averysecretvalue123 and ghp_abcdefghijklmnopqrstuvwxyz0123 please<system-reminder>hidden</system-reminder>" } },
    { type: "assistant", sessionId: SESSION, timestamp: at(1), message: { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "tool_use", name: "Bash", input: { command: "ls", description: "List files" } }] } },
  ];
  writeFileSync(path.join(dir, `${SESSION}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

test("session hooks record the session, add the context, and save the transcript redacted", () => {
  const root = workspace();
  dev(root, ["day", "start", "--no-sync"]);
  claudeTranscript(root);
  const env = { CLAUDE_PROJECT_DIR: root };

  const start = dev(root, ["hook", "session-start", "--tool", "claude"], { input: { session_id: SESSION, cwd: root }, env });
  assert.equal(start.code, 0, start.err);
  const context = JSON.parse(start.out).hookSpecificOutput;
  assert.equal(context.hookEventName, "SessionStart");
  assert.match(context.additionalContext, /^dev workspace\. Read AGENTS\.md/);
  assert.match(context.additionalContext, /Notes waiting: N-5\./);
  assert.doesNotMatch(context.additionalContext, /refreshing/, "a fresh snapshot isn't refreshed");

  const day = readdirSync(path.join(root, "work-sessions"))[0] ?? "";
  const folder = path.join(root, "work-sessions", day, readdirSync(path.join(root, "work-sessions", day))[0] ?? "");
  const reference = JSON.parse(readFileSync(path.join(folder, "session-ref.json"), "utf8"));
  assert.deepEqual({ ...reference, started: "x" }, { version: 1, tool: "claude", sessionId: SESSION, started: "x", ended: null, endReason: null, task: null, workingDir: "." });

  const end = dev(root, ["hook", "session-end", "--tool", "claude"], { input: { session_id: SESSION, cwd: root, reason: "exit" }, env });
  assert.equal(end.code, 0, end.err);
  const transcript = readFileSync(path.join(folder, "session.md"), "utf8");
  assert.match(transcript, /## User · \d\d:\d\d\n\nUse \[REDACTED\] and \[REDACTED:github-token\] please\n/);
  assert.doesNotMatch(transcript, /hidden|averysecret|ghp_/);
  assert.match(transcript, /\*\*Bash\*\*: List files\n\n```bash\nls\n```/);
  assert.equal(JSON.parse(readFileSync(path.join(folder, "session-ref.json"), "utf8")).endReason, "exit");

  const summary = dev(root, ["day", "end"]);
  assert.equal(summary.code, 0, summary.err);
  assert.match(readFileSync(path.join(root, "work-sessions", day, "summary.md"), "utf8"), /- \d\d:\d\d Claude Code · \[transcript\]\(.*\/session\.md\)/);
});

test("the Claude hook file stands down when Copilot or VS Code runs it", () => {
  const root = workspace();
  for (const input of [{ sessionId: SESSION }, { session_id: SESSION, timestamp: "2026-11-08T10:00:00Z" }]) {
    assert.deepEqual(JSON.parse(dev(root, ["hook", "session-start", "--tool", "claude"], { input, env: { CLAUDE_PROJECT_DIR: root } }).out), {});
    assert.deepEqual(JSON.parse(dev(root, ["hook", "pre-tool", "--tool", "claude"], { input: { ...input, toolArgs: { command: "gh pr merge 1" } } }).out), {});
  }
  assert.ok(!existsSync(path.join(root, "work-sessions")));
});

test("the generated hooks do nothing when dev isn't installed", () => {
  const root = workspace();
  const copilot = JSON.parse(readFileSync(path.join(root, ".github", "hooks", "dev.json"), "utf8")).hooks;
  const claude = JSON.parse(readFileSync(path.join(root, ".claude", "settings.json"), "utf8")).hooks;
  const commands = [
    copilot.sessionStart[0].bash, copilot.sessionEnd[0].bash, copilot.preToolUse[0].bash,
    claude.SessionStart[0].hooks[0].command, claude.SessionEnd[0].hooks[0].command, claude.PreToolUse[0].hooks[0].command,
  ];
  for (const command of commands) {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout + result.stderr, "", command);
  }
  assert.equal(claude.PreToolUse[0].matcher, "Bash|Edit|Write|MultiEdit|NotebookEdit");
});

// ---------------------------------------------------------------------------
// The command check

function preTool(root: string, command: string, tool: "claude" | "copilot") {
  const input = tool === "claude" ? { session_id: SESSION, tool_name: "Bash", tool_input: { command } } : { sessionId: SESSION, toolName: "bash", toolArgs: JSON.stringify({ command }) };
  const out = JSON.parse(dev(root, ["hook", "pre-tool", "--tool", tool], { input, env: tool === "claude" ? { CLAUDE_PROJECT_DIR: root } : {} }).out);
  return tool === "claude" ? out.hookSpecificOutput : out;
}

test("the command check allows reads, asks before changes, and blocks the token", () => {
  const root = workspace();
  const cases: Array<[string, string | undefined]> = [
    ["gh pr view 12", "allow"],
    ["cd repository && gh pr diff 12 | head -20", "allow"],
    ["gh pr merge 12 --squash", "ask"],
    ["gh api repos/o/r/issues/1/comments -f body=hi", "ask"],
    ["bash -c 'gh pr comment 1 -b hi'", "ask"],
    ["echo $(gh pr close 3)", "ask"],
    ["gh auth token", "deny"],
    ["gh auth token --help", "allow"],
    ["dev notes list", "allow"],
    ["dev notes post hello", "ask"],
    ["dev login github", "ask"],
    ["dev add jira", "ask"],
    ["dev remove notes", "ask"],
    ["dev notes scope", "allow"],
    ["dev notes scope --set '{ book: other }'", "ask"],
    ["echo 'services: []' > dev.yaml", "ask"],
    ["sed -i '' s/team/other/ dev.yaml", "ask"],
    ["cat dev.yaml", undefined],
    ["cat dev.yaml > copy.yaml", undefined],
    ["rm ~/.config/dev/policy.json", "ask"],
    ["sed -i '' s/a/b/ repository/config/dev.yaml", undefined],
    ["dev day start", undefined],
    ["ls /dev/null && find /dev -name x", undefined],
    ["gh pr view 1 > out.md", undefined],
    ["git status", undefined],
  ];
  for (const [command, expected] of cases) {
    assert.equal(preTool(root, command, "claude")?.permissionDecision, expected, command);
  }

  const copilot = preTool(root, "gh pr view 12", "copilot");
  assert.equal(copilot.permissionDecision, "allow");
  assert.equal(copilot.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(preTool(root, "gh auth token", "copilot").permissionDecisionReason, /Don't try another way/);
});

test("the policy file changes decisions, and dev check explains them", () => {
  const root = workspace();
  const config = path.join(base, "config-policy");
  mkdirSync(path.join(config, "dev"), { recursive: true });
  writeFileSync(path.join(config, "dev", "policy.json"), JSON.stringify({ change: "deny", commands: { "gh pr create": "allow" } }));
  const env = { XDG_CONFIG_HOME: config };

  const merge = dev(root, ["check", "gh pr merge 1"], { env });
  assert.match(merge.out, /^Decision: deny\n {2}gh pr merge: changes something\. Rule change: deny\n$/);
  assert.match(dev(root, ["check", "gh", "pr", "create", "--fill"], { env }).out, /Decision: allow\n {2}gh pr create: .*Rule "gh pr create": allow/);
  assert.match(dev(root, ["check", "git push"], { env }).out, /^No command the check knows/);

  writeFileSync(path.join(config, "dev", "policy.json"), "{ broken");
  assert.match(dev(root, ["check", "gh pr merge 1"], { env }).out, /Decision: ask[\s\S]*Policy: defaults, because the policy file isn't valid JSON/);
});

test("file edits to dev.yaml or the dev settings ask first, and other files are left to the tool", () => {
  const root = workspace();
  const edit = (tool: "claude" | "copilot", file: string, name = tool === "claude" ? "Edit" : "edit") => {
    const input = tool === "claude" ? { session_id: SESSION, tool_name: name, tool_input: { file_path: file } } : { sessionId: SESSION, toolName: name, toolArgs: JSON.stringify({ path: file }) };
    const out = JSON.parse(dev(root, ["hook", "pre-tool", "--tool", tool], { input, env: tool === "claude" ? { CLAUDE_PROJECT_DIR: root } : {} }).out);
    return (tool === "claude" ? out.hookSpecificOutput : out)?.permissionDecision;
  };
  assert.equal(edit("claude", path.join(root, "dev.yaml")), "ask");
  assert.equal(edit("claude", path.join(root, "dev.yaml"), "Write"), "ask");
  assert.equal(edit("copilot", path.join(root, "dev.yaml")), "ask");
  assert.equal(edit("claude", path.join(base, "config", "dev", "policy.json")), "ask");
  assert.equal(edit("claude", path.join(root, "repository", "dev.yaml")), undefined, "a dev.yaml in the code is the code's");
  assert.equal(edit("claude", path.join(root, "AGENTS.md")), undefined);
  assert.equal(edit("claude", path.join(root, "dev.yaml"), "Read"), undefined, "reading is fine");
});

test("config changes can be blocked outright in the policy", () => {
  const root = workspace();
  const config = path.join(base, "config-strict");
  mkdirSync(path.join(config, "dev"), { recursive: true });
  writeFileSync(path.join(config, "dev", "policy.json"), JSON.stringify({ config: "deny" }));
  const out = dev(root, ["check", "dev notes scope --set '{ book: x }'"], { env: { XDG_CONFIG_HOME: config } }).out;
  assert.match(out, /Decision: deny\n {2}dev notes scope: changes what Example notes syncs\. Rule config: deny/);
});

test("a running refresh is marked, so others can tell, and a killed one is noticed", () => {
  const root = workspace();
  const marker = path.join(root, ".dev", "state", "sync.json");

  assert.match(dev(root, ["day", "status"]).out, /No sync is running\. There's no snapshot\.md yet\./);

  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ pid: process.pid, started: "2026-11-09T02:46:00.000Z", command: "dev sync jira" }));
  assert.match(dev(root, ["day", "status"]).out, /A sync is running: dev sync jira, since \d\d:\d\d\./);
  assert.match(dev(root, ["sync"]).err, /A sync is already running: dev sync jira/);
  const second = dev(root, ["day", "start"]);
  assert.equal(second.code, 1);
  assert.match(second.err, /A sync is already running/);
  assert.equal(dev(root, ["day", "start", "--no-sync"]).code, 0, "rewriting the snapshot from disk is still fine");
  assert.equal(dev(root, ["notes", "list"]).code, 0, "a command that writes no workspace files runs alongside a sync");
  const waited = dev(root, ["notes", "post", "hi"], { env: { DEV_SYNC_WAIT: "1" } });
  assert.match(waited.err, /Waiting for a running sync to finish: dev sync jira/, "one that writes them waits its turn");
  assert.match(waited.err, /A sync is already running/, "and gives up when the sync outlasts the wait");

  const start = dev(root, ["hook", "session-start", "--tool", "claude"], { input: { session_id: SESSION, cwd: root }, env: { CLAUDE_PROJECT_DIR: root } });
  assert.match(JSON.parse(start.out).hookSpecificOutput.additionalContext, /A sync is running: dev sync jira, since \d\d:\d\d.*dev day status/);

  writeFileSync(marker, JSON.stringify({ pid: 2147483646, started: "2026-11-09T02:46:00.000Z", command: "dev day start" }));
  assert.match(dev(root, ["day", "status"]).out, /dev day start, started at \d\d:\d\d, stopped before finishing[\s\S]*No sync is running/);
  assert.ok(existsSync(marker), "status reads never remove a stale marker");
  assert.equal(dev(root, ["sync"]).code, 0, "the next sync takes over a dead process's marker");
  assert.ok(!existsSync(marker));

  writeFileSync(marker, "{ half-written");
  utimesSync(marker, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.match(dev(root, ["sync"]).err, /unreadable lock/, "a marker with no known owner is left for the person");
  assert.equal(dev(root, ["sync", "--recover"]).code, 0);

  assert.equal(dev(root, ["day", "start"]).code, 0);
  assert.equal(dev(root, ["sync"]).code, 0);
  assert.ok(!existsSync(marker), "a finished sync removes its marker");
});
