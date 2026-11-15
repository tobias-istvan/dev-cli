/**
 * How progress is shown: live for a person at a terminal, plain lines for agents, scripts
 * and logs, with results on stdout either way.
 */
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { liveProgress, step, tally } from "../src/core/progress.ts";

const tty = { stdout: process.stdout.isTTY, stderr: process.stderr.isTTY };
const env = { ...process.env };
after(() => {
  process.stdout.isTTY = tty.stdout;
  process.stderr.isTTY = tty.stderr;
  process.env = env;
});

function terminal(on: boolean, vars: Record<string, string | undefined> = {}) {
  process.stdout.isTTY = on;
  process.stderr.isTTY = on;
  process.env = { ...env, CI: undefined, CLAUDECODE: undefined, TERM: "xterm-256color", DEV_PROGRESS: undefined, DEV_PROMPTS: undefined, ...vars };
  for (const [key, value] of Object.entries(process.env)) if (value === undefined) delete process.env[key];
}

test("live only for a terminal that isn't CI, an agent, a dumb terminal or asked to be plain", () => {
  terminal(true);
  assert.equal(liveProgress(), true);
  terminal(false);
  assert.equal(liveProgress(), false);
  for (const vars of [{ CI: "true" }, { CLAUDECODE: "1" }, { TERM: "dumb" }, { DEV_PROGRESS: "plain" }, { DEV_PROMPTS: "classic" }]) {
    terminal(true, vars);
    assert.equal(liveProgress(), false, JSON.stringify(vars));
  }
  terminal(true, { CI: "false" });
  assert.equal(liveProgress(), true, "CI=false isn't CI");
  // Output piped to a file or another program, with a person still watching stderr.
  terminal(true);
  process.stdout.isTTY = false;
  assert.equal(liveProgress(), false);
});

function recorder() {
  const lines: string[] = [];
  return { lines, out: { info: (m: string) => lines.push(`out: ${m}`), warn: (m: string) => lines.push(`warn: ${m}`), progress: (m: string) => lines.push(`progress: ${m}`) } };
}

test("plain: what started, progress now and then, and what it found on stdout", async () => {
  terminal(false);
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { lines, out } = recorder();
    const result = await step(out, "Syncing Jira", async (report) => {
      report("1 of 40 tickets");
      mock.timers.tick(2000);
      report("12 of 40 tickets");
      mock.timers.tick(4000);
      report("30 of 40 tickets");
      return 40;
    }, (n) => `Jira: ${n} synced.`);
    assert.equal(result, 40);
    assert.deepEqual(lines, ["progress: Syncing Jira...", "progress: Syncing Jira: 30 of 40 tickets (6.0s)", "out: Jira: 40 synced."]);
  } finally {
    mock.timers.reset();
  }
});

test("plain: nothing at all without an Output for progress, like the session hook's", async () => {
  terminal(false);
  const lines: string[] = [];
  await step({ info: (m) => lines.push(m), warn: (m) => lines.push(m) }, "Syncing Jira", async () => 1);
  assert.deepEqual(lines, []);
});

test("a step inside a step reports through the outer one, and failures still reach the caller", async () => {
  terminal(false);
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { lines, out } = recorder();
    await step(out, "Syncing Confluence", async () => {
      mock.timers.tick(6000);
      await step(out, "Following links", async (report) => { report("2 of 3"); }, () => "Confluence: 3 new from links.");
    });
    assert.deepEqual(lines, ["progress: Syncing Confluence...", "progress: Syncing Confluence: Following links (6.0s)", "out: Confluence: 3 new from links."]);
    await assert.rejects(step(out, "Checking the GitHub login", async () => { throw new Error("offline"); }), /offline/);
  } finally {
    mock.timers.reset();
  }
});

test("tally counts work as it finishes", () => {
  const seen: string[] = [];
  const tick = tally((d) => seen.push(d), 2, "ticket", undefined, "ABC: ");
  tick();
  tick();
  assert.deepEqual(seen, ["ABC: 0 of 2 tickets", "ABC: 1 of 2 tickets", "ABC: 2 of 2 tickets"]);
});
