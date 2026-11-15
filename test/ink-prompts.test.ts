/**
 * The ink questions dev init asks: the key handling on its own, then whole questions
 * answered through fake terminal streams.
 */
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import { highlight, pickerKey, pickMany, pickOne, pickRemote, type PickerState, running, terminal, text, windowStart, yesNo } from "../src/core/ink-prompts.ts";
import { elapsed } from "../src/core/progress.ts";
import { rank, withInkPrompts } from "../src/core/prompt.ts";

const repos = Array.from({ length: 40 }, (_, i) => ({ value: `acme/repo-${i}`, name: `acme/repo-${i}` }));
const options = (results = repos, multiple = false, optional = false) => ({ results, multiple, optional, pageSize: 10 });
const start: PickerState<string> = { term: "", active: 0, picked: [] };

test("typing filters, Backspace and Esc undo it, and moving resets to the top", () => {
  let state = pickerKey(start, "d", {}, options()).state;
  state = pickerKey(state, "s", {}, options()).state;
  assert.equal(state.term, "ds");
  state = pickerKey({ ...state, active: 3 }, "", { backspace: true }, options()).state;
  assert.deepEqual([state.term, state.active], ["d", 0]);
  assert.equal(pickerKey(state, "", { escape: true }, options()).state.term, "");
  assert.equal(pickerKey(state, "u", { ctrl: true }, options()).state.term, "");
  // Control keys don't end up in the filter.
  assert.equal(pickerKey(start, "x", { ctrl: true }, options()).state.term, "");
  assert.equal(pickerKey(start, "a\u001b", {}, options()).state.term, "a");
});

test("the arrows wrap, and Page Up/Down, Home and End jump without wrapping", () => {
  assert.equal(pickerKey(start, "", { upArrow: true }, options()).state.active, 39);
  assert.equal(pickerKey({ ...start, active: 39 }, "", { downArrow: true }, options()).state.active, 0);
  assert.equal(pickerKey(start, "", { pageDown: true }, options()).state.active, 10);
  assert.equal(pickerKey({ ...start, active: 35 }, "", { pageDown: true }, options()).state.active, 39);
  assert.equal(pickerKey({ ...start, active: 5 }, "", { pageUp: true }, options()).state.active, 0);
  assert.equal(pickerKey({ ...start, active: 5 }, "", { end: true }, options()).state.active, 39);
  assert.equal(pickerKey({ ...start, active: 5 }, "", { home: true }, options()).state.active, 0);
  assert.equal(pickerKey(start, "", { downArrow: true }, options([])).state.active, 0);
});

test("Enter takes the highlighted row, or the picks, or none when that's allowed", () => {
  assert.deepEqual(pickerKey({ ...start, active: 2 }, "", { return: true }, options()).done, ["acme/repo-2"]);
  assert.equal(pickerKey(start, "", { return: true }, options([])).done, undefined);
  assert.deepEqual(pickerKey({ ...start, picked: ["acme/repo-7"] }, "", { return: true }, options(repos, true)).done, ["acme/repo-7"]);
  assert.deepEqual(pickerKey(start, "", { return: true }, options(repos, true)).done, ["acme/repo-0"]);
  assert.deepEqual(pickerKey(start, "", { return: true }, options(repos, true, true)).done, []);
});

test("Tab picks and drops, and Ctrl+A picks or drops everything shown", () => {
  let state = pickerKey(start, "", { tab: true }, options(repos, true)).state;
  assert.deepEqual(state.picked, ["acme/repo-0"]);
  assert.deepEqual(pickerKey(state, "", { tab: true }, options(repos, true)).state.picked, []);
  // Tab does nothing when choosing one.
  assert.deepEqual(pickerKey(start, "", { tab: true }, options()).state.picked, []);

  const shown = repos.slice(0, 3);
  state = pickerKey({ ...start, picked: ["acme/repo-1", "acme/repo-30"] }, "a", { ctrl: true }, options(shown, true)).state;
  assert.deepEqual(state.picked, ["acme/repo-1", "acme/repo-30", "acme/repo-0", "acme/repo-2"]);
  assert.deepEqual(pickerKey(state, "a", { ctrl: true }, options(shown, true)).state.picked, ["acme/repo-30"]);
});

test("the visible window keeps the highlighted row in view", () => {
  assert.equal(windowStart(0, 40, 10), 0);
  assert.equal(windowStart(20, 40, 10), 15);
  assert.equal(windowStart(39, 40, 10), 30);
  assert.equal(windowStart(3, 4, 10), 0);
});

test("matched letters are marked, whole words first, then letters in order", () => {
  const marked = (term: string, name: string) => highlight(term, name).filter((p) => p.match).map((p) => p.text);
  assert.deepEqual(marked("sys", "Design System"), ["Sys"]);
  assert.deepEqual(marked("dsgn", "Design"), ["D", "s", "gn"]);
  assert.deepEqual(marked("", "Design"), []);
  assert.equal(highlight("des sys", "Design System").map((p) => p.text).join(""), "Design System");
});

let interrupts = 0;

/** A terminal for ink to draw on and read keys from, like a person at a keyboard. */
function fakeTerminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let screen = "";
  const stdout = Object.assign(new Writable({ write: (chunk, _encoding, next) => { screen += chunk.toString(); next(); } }), { isTTY: true, columns: 100, rows: 30 });
  terminal.stdin = stdin;
  terminal.stdout = stdout;
  terminal.stderr = stdout;
  interrupts = 0;
  terminal.interrupt = () => { interrupts++; };
  return {
    async type(...keys: string[]) {
      for (const key of keys) {
        await wait(30);
        stdin.write(key);
      }
    },
    screen: () => screen,
  };
}

const DOWN = "\u001b[B";
const TAB = "\t";
const ENTER = "\r";

test("a whole question: filter a long list, move, and choose", async () => {
  const tty = fakeTerminal();
  const answer = pickOne("Which repository?", repos, rank);
  await tty.type("-", "3", DOWN, ENTER);
  // "-3" matches repo-3, then repo-30 to repo-39.
  assert.equal(await answer, "acme/repo-30");
  assert.match(tty.screen(), /✔ Which repository\?/);
});

test("a whole question: pick several, with the answer naming them", async () => {
  const tty = fakeTerminal();
  const answer = pickMany("Which services?", [{ value: "jira", name: "Jira" }, { value: "notion", name: "Notion" }, { value: "figma", name: "Figma" }], rank, true);
  await tty.type(TAB, DOWN, DOWN, TAB, ENTER);
  assert.deepEqual(await answer, ["jira", "figma"]);
  assert.match(tty.screen(), /Jira, Figma/);
});

test("a whole question: search a service as you type, using only the latest answer", async () => {
  const tty = fakeTerminal();
  const asked: string[] = [];
  const pages = ["Home", "Design System", "Roadmap"].map((name) => ({ value: name.toLowerCase(), name }));
  const answer = pickRemote("Which page?", async (term) => { asked.push(term); return pages.filter((p) => p.name.toLowerCase().includes(term)); }, rank);
  await wait(300);
  await tty.type("r", "o", "a");
  await wait(400);
  await tty.type(ENTER);
  assert.equal(await answer, "roadmap");
  // Typing quickly asks once for the whole word, not once a letter.
  assert.deepEqual(asked, ["", "roa"]);
});

test("text, hidden text and yes/no questions", async () => {
  let tty = fakeTerminal();
  let typed = text("GitLab server:", { initial: "https://gitlab.com", required: true });
  await tty.type(ENTER);
  assert.equal(await typed, "https://gitlab.com");

  tty = fakeTerminal();
  typed = text("Token:", { mask: true });
  await tty.type("s3", "cret", "\u007f", ENTER);
  assert.equal(await typed, "s3cre");
  assert.doesNotMatch(tty.screen(), /s3cre/);

  tty = fakeTerminal();
  const yes = yesNo("Log in?", false);
  await tty.type("y");
  assert.equal(await yes, true);
});

test("Ctrl+C cancels with a clear error", async () => {
  const tty = fakeTerminal();
  const answer = pickOne("Which repository?", repos, rank);
  await tty.type("\u0003");
  await assert.rejects(answer, /Cancelled/);
});

test("without a terminal, init's ink questions still say which flag to use", async () => {
  const { choose } = await import("../src/core/prompt.ts");
  await assert.rejects(withInkPrompts(() => choose("Where?", [{ value: "a", name: "A" }], "--where")), (error: { fix?: string }) => error.fix === "Pass --where instead.");
});

test("a step shows a spinner with its progress, then what it found and how long it took", async () => {
  const tty = fakeTerminal();
  const result = await running("Finding your boards", async (report) => {
    report("acme (1 of 2)");
    await wait(120);
    report("globex (2 of 2), 3 boards so far");
    await wait(120);
    return [1, 2, 3, 4];
  }, (found) => `Found ${found.length} open boards`);
  assert.deepEqual(result, [1, 2, 3, 4]);
  assert.match(tty.screen(), /Finding your boards… acme \(1 of 2\)/);
  assert.match(tty.screen(), /globex \(2 of 2\), 3 boards so far/);
  assert.match(tty.screen(), /✔ Found 4 open boards \d+ms/);
});

test("a step that fails says so, and the error still reaches dev", async () => {
  const tty = fakeTerminal();
  await assert.rejects(running("Loading Jira projects", async () => { throw new Error("401 Unauthorized"); }), /401/);
  assert.match(tty.screen(), /✖ Loading Jira projects failed after/);
});

test("waits read naturally", () => {
  assert.equal(elapsed(850), "850ms");
  assert.equal(elapsed(4230), "4.2s");
  assert.equal(elapsed(65_000), "1m 05s");
});

test("keys pressed during a step are swallowed, and Ctrl+C cancels it", async () => {
  const tty = fakeTerminal();
  const step = running("Loading Confluence spaces", () => new Promise(() => {}));
  await tty.type("x", "y");
  assert.doesNotMatch(tty.screen(), /[xy]/);
  await tty.type("\u0003");
  await assert.rejects(step, /Cancelled/);
  assert.match(tty.screen(), /✖ Loading Confluence spaces cancelled after/);
  // Then dev is interrupted, as Ctrl+C would have done without the spinner.
  assert.equal(interrupts, 1);
});

test("a quick step with nothing to say leaves no line behind", async () => {
  const tty = fakeTerminal();
  await running("Pointing links at the local copies", async () => 3);
  assert.doesNotMatch(tty.screen().split("\n").at(-1) ?? "", /Pointing links/);
  assert.doesNotMatch(tty.screen(), /✔/);
});
