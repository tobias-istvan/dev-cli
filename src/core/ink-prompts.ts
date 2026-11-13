import { Box, render, Text, useApp, useInput, useWindowSize, type Key } from "ink";
import { createElement as h, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DevError } from "./output.ts";

/**
 * The same questions as prompt.ts, drawn with ink. An experiment, used by dev init only, for
 * a better time with long lists: every list filters as you type, scrolls with the arrows and
 * Page Up/Down, shows where you are in it, and marks the letters that matched.
 * Written with createElement rather than JSX, so the files stay plain TypeScript.
 */

export type Choice<T> = { value: T; name: string; description?: string; checked?: boolean };
type Rank = <C extends { name: string; description?: string }>(term: string, choices: C[]) => C[];

/** Where a picker is: the filter typed so far, the highlighted row, and what's picked. */
export type PickerState<T> = { term: string; active: number; picked: T[] };

export type PickerOptions<T> = {
  results: Array<Choice<T>>;
  multiple: boolean;
  /** Picking nothing is an answer. */
  optional: boolean;
  pageSize: number;
};

/**
 * What a key press does to a picker, kept apart from drawing so it can be tested. Space is
 * part of the filter, so "dsgn sys" works. Tab picks or drops, Ctrl+A picks everything shown,
 * Esc or Ctrl+U clears the filter. Enter finishes: with nothing picked it takes the highlighted
 * row, unless the question is optional, when it means none.
 */
export function pickerKey<T>(state: PickerState<T>, input: string, key: Partial<Key>, options: PickerOptions<T>): { state: PickerState<T>; done?: T[] } {
  const { results, multiple, optional, pageSize } = options;
  const active = Math.min(state.active, Math.max(0, results.length - 1));
  const current = results[active];
  const last = Math.max(0, results.length - 1);

  if (key.return) {
    if (multiple && (state.picked.length > 0 || optional)) return { state, done: state.picked };
    return current ? { state, done: [current.value] } : { state };
  }
  if (key.upArrow || key.downArrow) {
    if (results.length === 0) return { state };
    return { state: { ...state, active: (active + (key.upArrow ? -1 : 1) + results.length) % results.length } };
  }
  if (key.pageUp) return { state: { ...state, active: Math.max(0, active - pageSize) } };
  if (key.pageDown) return { state: { ...state, active: Math.min(last, active + pageSize) } };
  if (key.home) return { state: { ...state, active: 0 } };
  if (key.end) return { state: { ...state, active: last } };
  if (key.tab) {
    if (!multiple || !current) return { state };
    const picked = state.picked.includes(current.value) ? state.picked.filter((v) => v !== current.value) : [...state.picked, current.value];
    return { state: { ...state, picked } };
  }
  if (key.ctrl && input === "a") {
    if (!multiple) return { state };
    const shown = results.map((c) => c.value);
    const all = shown.every((v) => state.picked.includes(v));
    const picked = all ? state.picked.filter((v) => !shown.includes(v)) : [...state.picked, ...shown.filter((v) => !state.picked.includes(v))];
    return { state: { ...state, picked } };
  }
  if (key.escape || (key.ctrl && input === "u")) return { state: { ...state, term: "", active: 0 } };
  if (key.backspace || key.delete) return { state: { ...state, term: state.term.slice(0, -1), active: 0 } };
  const typed = printable(input, key);
  if (typed) return { state: { ...state, term: state.term + typed, active: 0 } };
  return { state };
}

/** The text a key press types, without control characters. Pasting arrives as several at once. */
function printable(input: string, key: Partial<Key>): string {
  if (key.ctrl || key.meta) return "";
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** The first row to show so the highlighted one stays in view, near the middle. */
export function windowStart(active: number, count: number, size: number): number {
  return Math.max(0, Math.min(active - Math.floor(size / 2), count - size));
}

/** A name split into the parts that matched each typed word, for marking them. */
export function highlight(term: string, text: string): Array<{ text: string; match: boolean }> {
  const marks = new Array<boolean>(text.length).fill(false);
  const lower = text.toLowerCase();
  for (const word of term.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = lower.indexOf(word);
    if (at !== -1) {
      marks.fill(true, at, at + word.length);
      continue;
    }
    // Letters in order, as fuzzyScore matches them.
    let position = -1;
    for (const letter of word) {
      const next = lower.indexOf(letter, position + 1);
      if (next === -1) break;
      marks[next] = true;
      position = next;
    }
  }
  const parts: Array<{ text: string; match: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const tail = parts[parts.length - 1];
    if (tail && tail.match === marks[i]) tail.text += text.charAt(i);
    else parts.push({ text: text.charAt(i), match: Boolean(marks[i]) });
  }
  return parts;
}

class Cancelled extends DevError {
  constructor() {
    super("Cancelled.");
  }
}

/** Where questions are asked. Tests swap in their own streams. */
export const terminal: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = { stdin: process.stdin, stdout: process.stdout };

/** Mounts a question, waits for its answer, and leaves the answered line on screen. */
async function ask<R>(element: ReactNode): Promise<R> {
  const app = render(element, { ...terminal, exitOnCtrlC: false, patchConsole: false });
  return (await app.waitUntilExit()) as R;
}

/** Finishes with `value` once the answered line has been drawn. */
function useFinish<R>(): [R | undefined, (value: R) => void, () => void] {
  const { exit } = useApp();
  const [answer, setAnswer] = useState<{ value: R }>();
  useEffect(() => {
    if (answer) exit(answer.value);
  }, [answer]);
  return [answer?.value, (value) => setAnswer({ value }), () => exit(new Cancelled())];
}

const Answered = ({ message, answer }: { message: string; answer: string }) =>
  h(Text, null, h(Text, { color: "green" }, "✔ "), h(Text, { bold: true }, message), " ", h(Text, { color: "cyan" }, answer));

const Question = ({ message, children }: { message: string; children?: ReactNode }) =>
  h(Text, null, h(Text, { color: "green" }, "? "), h(Text, { bold: true }, message), " ", children);

const Help = ({ keys }: { keys: Array<[string, string]> }) =>
  h(Text, { dimColor: true, wrap: "truncate-end" }, keys.map(([k, action], i) => h(Fragment, { key: k }, i > 0 ? " • " : "", h(Text, { bold: true, dimColor: false }, k), " ", action)));

type PickerProps<T> = {
  message: string;
  multiple: boolean;
  optional?: boolean;
  rank: Rank;
  /** A list to filter, or a service to ask as you type. */
  choices?: Array<Choice<T>>;
  find?: (term: string) => Promise<Array<Choice<T>>>;
};

function Picker<T extends string>({ message, multiple, optional = false, rank, choices, find }: PickerProps<T>) {
  const { rows } = useWindowSize();
  const pageSize = Math.max(3, Math.min(12, rows - 7));
  const [answer, finish, cancel] = useFinish<T[]>();
  const [state, setState] = useState<PickerState<T>>({ term: "", active: 0, picked: (choices ?? []).filter((c) => c.checked).map((c) => c.value) });
  const [found, setFound] = useState<{ term: string; results: Array<Choice<T>> }>();
  const [failed, setFailed] = useState<string>();
  // Names seen so far, so the answer can name picks that a later search left out.
  const seen = useRef(new Map<T, string>());

  // A remote list waits for a pause in typing, so each keystroke isn't a request, and ignores
  // answers to anything but the latest term.
  useEffect(() => {
    if (!find) return;
    let stale = false;
    const timer = setTimeout(() => {
      find(state.term).then(
        (results) => { if (!stale) { setFound({ term: state.term, results: rank(state.term, results) }); setFailed(undefined); } },
        (error: Error) => { if (!stale) setFailed(error.message); },
      );
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [state.term]);

  const results = useMemo(() => (choices ? rank(state.term, choices) : (found?.results ?? [])), [state.term, found]);
  for (const c of results) seen.current.set(c.value, c.name);
  const loading = Boolean(find) && found?.term !== state.term;
  const active = Math.min(state.active, Math.max(0, results.length - 1));
  const current = results[active];

  useInput((input, key) => {
    if (answer) return;
    if (key.ctrl && input === "c") return cancel();
    const next = pickerKey(state, input, key, { results, multiple, optional, pageSize });
    if (next.done) finish(next.done);
    else if (next.state !== state) setState(next.state);
  });

  if (answer) {
    const names = answer.map((v) => seen.current.get(v) ?? v);
    return h(Answered, { message, answer: names.join(", ") || "none" });
  }

  const start = windowStart(active, results.length, pageSize);
  const shown = results.slice(start, start + pageSize);
  const above = start;
  const below = results.length - start - shown.length;
  const total = choices ? `${results.length} of ${choices.length}` : `${results.length}`;

  return h(
    Box,
    { flexDirection: "column" },
    h(Question, { message }, h(Text, { color: "cyan" }, state.term), h(Text, { inverse: true }, " ")),
    h(Text, { dimColor: true }, above > 0 ? `  ↑ ${above} more` : " "),
    results.length === 0
      ? h(Text, { color: loading ? undefined : "red", dimColor: loading }, failed ? `  ${failed}` : loading ? "  Searching…" : "  No matches")
      : shown.map((c, i) => {
          const isActive = start + i === active;
          const box = multiple ? (state.picked.includes(c.value) ? h(Text, { color: "green" }, "◉ ") : "◯ ") : "";
          return h(
            Text,
            { key: c.value, wrap: "truncate-end" },
            h(Text, { color: "cyan" }, isActive ? "❯ " : "  "),
            box,
            highlight(state.term, c.name).map((part, j) => h(Text, { key: j, bold: part.match || isActive, color: part.match ? "yellow" : isActive ? "cyan" : undefined }, part.text)),
          );
        }),
    h(Text, { dimColor: true }, below > 0 ? `  ↓ ${below} more` : " "),
    h(Text, { color: "cyan", wrap: "truncate-end" }, current?.description ?? " "),
    h(Text, { dimColor: true }, `${loading ? "Searching… " : ""}${total} shown${multiple ? `, ${state.picked.length} picked` : ""}`),
    h(Help, {
      keys: [
        ["type", "filter"],
        ["↑↓ pgup/pgdn", "move"],
        ...(multiple ? ([["tab", "pick"], ["^a", "pick all shown"]] as Array<[string, string]>) : []),
        ["esc", "clear"],
        ["⏎", multiple && optional && state.picked.length === 0 ? "none" : multiple ? "done" : "choose"],
      ],
    }),
  );
}

function TextQuestion({ message, initial, mask, required }: { message: string; initial?: string; mask?: boolean; required?: boolean }) {
  const [answer, finish, cancel] = useFinish<string>();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState(false);

  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.ctrl && input === "c") return cancel();
    if (key.return) {
      const result = value || initial || "";
      if (required && !result) return setProblem(true);
      return finish(result);
    }
    if (key.backspace || key.delete) return setValue(value.slice(0, -1));
    if (key.ctrl && input === "u") return setValue("");
    const typed = printable(input, key);
    if (typed) { setValue(value + typed); setProblem(false); }
  });

  const shown = (text: string) => (mask ? "*".repeat(text.length) : text);
  if (answer !== undefined) return h(Answered, { message, answer: shown(answer) });
  return h(
    Box,
    { flexDirection: "column" },
    h(Question, { message }, !value && initial ? h(Text, { dimColor: true }, `(${initial}) `) : "", h(Text, { color: "cyan" }, shown(value)), h(Text, { inverse: true }, " ")),
    problem ? h(Text, { color: "red" }, "An answer is needed.") : null,
  );
}

function ConfirmQuestion({ message, initial }: { message: string; initial: boolean }) {
  const [answer, finish, cancel] = useFinish<boolean>();
  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.ctrl && input === "c") return cancel();
    if (key.return) finish(initial);
    else if (/^y$/i.test(input)) finish(true);
    else if (/^n$/i.test(input)) finish(false);
  });
  if (answer !== undefined) return h(Answered, { message, answer: answer ? "Yes" : "No" });
  return h(Question, { message }, h(Text, { dimColor: true }, initial ? "(Y/n)" : "(y/N)"));
}

export async function pickOne<T extends string>(message: string, choices: Array<Choice<T>>, rank: Rank): Promise<T> {
  const [value] = await ask<T[]>(h(Picker<T>, { message, choices, rank, multiple: false }));
  return value as T;
}

export function pickMany<T extends string>(message: string, choices: Array<Choice<T>>, rank: Rank, optional: boolean): Promise<T[]> {
  return ask<T[]>(h(Picker<T>, { message, choices, rank, multiple: true, optional }));
}

export async function pickRemote<T extends string>(message: string, find: (term: string) => Promise<Array<Choice<T>>>, rank: Rank): Promise<T> {
  const [value] = await ask<T[]>(h(Picker<T>, { message, find, rank, multiple: false }));
  return value as T;
}

export function text(message: string, options: { initial?: string; mask?: boolean; required?: boolean } = {}): Promise<string> {
  return ask<string>(h(TextQuestion, { message, ...options }));
}

export function yesNo(message: string, initial: boolean): Promise<boolean> {
  return ask<boolean>(h(ConfirmQuestion, { message, initial }));
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** "850ms" under a second, then "4.2s", then "1m 05s". */
export function elapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

type StepProps = { label: string; detail: string; started: number; status: "running" | "done" | "failed" | "cancelled"; summary?: string; onCancel: () => void };

function Step({ label, detail, started, status, summary, onCancel }: StepProps) {
  const [now, setNow] = useState(Date.now());
  // Keys pressed while waiting would print over the spinner and then answer the next question
  // unseen, so they're swallowed. Ctrl+C still stops.
  useInput((input, key) => {
    if (key.ctrl && input === "c") onCancel();
  }, { isActive: status === "running" });
  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(timer);
  }, [status]);
  const took = elapsed((status === "running" ? now : Date.now()) - started);

  if (status === "done") return h(Text, null, h(Text, { color: "green" }, "✔ "), summary ?? label, h(Text, { dimColor: true }, ` ${took}`));
  if (status !== "running") return h(Text, null, h(Text, { color: "red" }, "✖ "), label, h(Text, { dimColor: true }, ` ${status} after ${took}`));
  const frame = SPINNER[Math.floor((now - started) / 80) % SPINNER.length];
  // The time shows once the wait is long enough to wonder about.
  return h(
    Text,
    { wrap: "truncate-end" },
    h(Text, { color: "cyan" }, `${frame} `),
    `${label}…`,
    detail ? h(Text, { color: "cyan" }, ` ${detail}`) : "",
    now - started >= 1000 ? h(Text, { dimColor: true }, ` ${took}`) : "",
  );
}

/** Shows a spinner while `task` runs, then a line saying what it found, or that it failed. */
export async function running<T>(label: string, task: (report: (detail: string) => void) => Promise<T>, done?: (result: T) => string): Promise<T> {
  const started = Date.now();
  let detail = "";
  let cancel = () => {};
  const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Cancelled()); });
  const view = (status: StepProps["status"], summary?: string) => h(Step, { label, detail, started, status, summary, onCancel: cancel });
  // Logs from the task print above the spinner.
  const app = render(view("running"), { ...terminal, exitOnCtrlC: false, patchConsole: true });
  const finish = async (node: ReactNode) => {
    app.rerender(node);
    await app.waitUntilRenderFlush();
    app.unmount();
    await app.waitUntilExit();
  };
  try {
    const result = await Promise.race([
      task((next) => {
        detail = next;
        app.rerender(view("running"));
      }),
      cancelled,
    ]);
    await finish(view("done", done?.(result)));
    return result;
  } catch (error) {
    await finish(view(error instanceof Cancelled ? "cancelled" : "failed"));
    throw error;
  }
}
