import { styleText } from "node:util";
import type { Output } from "../plugins/types.ts";

/**
 * Telling whoever's waiting what's happening. Results always go to stdout as before; only
 * how the waiting looks depends on who's likely reading:
 *
 * - A person at a terminal gets a live line on stderr: a spinner naming the work, how far
 *   along it is and how long it's taken, then a line saying what it found.
 * - Agents, scripts, CI and logs get plain lines on stderr: what started, how far along it
 *   is now and then, and what it found on stdout. No colour or cursor codes.
 *
 * Nobody can tell a person from an agent, so a terminal stands in for a person, minus the
 * cases known to be otherwise. DEV_PROGRESS=plain asks for plain lines anywhere.
 */

/** How often a plain line repeats a long step's progress. */
const PLAIN_EVERY = 5000;

const set = (name: string) => Boolean(process.env[name]) && !["0", "false"].includes(process.env[name]!.toLowerCase());

/** Whether progress is drawn live: someone's watching a terminal, and it isn't CI or an agent. */
export function liveProgress(): boolean {
  if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
  // Claude Code sets CLAUDECODE in the shells it runs commands in.
  if (set("CI") || set("CLAUDECODE") || process.env.TERM === "dumb") return false;
  return process.env.DEV_PROGRESS !== "plain" && process.env.DEV_PROMPTS !== "classic";
}

/** "850ms" under a second, then "4.2s", then "1m 05s". */
export function elapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The step running now. A step inside it reports through it, as one line can't hold two spinners. */
let current: ((detail: string) => void) | undefined;

/**
 * Runs `task`, showing `label` while it does. The task can `report` how far it's got, like
 * "40 of 120". `done` says what it found, printed to stdout once it's finished; leave it out,
 * or return undefined, for work with nothing to say.
 */
export async function step<T>(out: Output, label: string, task: (report: (detail: string) => void) => Promise<T>, done?: (result: T) => string | undefined): Promise<T> {
  if (current) {
    const outer = current;
    outer(label);
    const result = await task((detail) => outer(`${label}: ${detail}`));
    const summary = done?.(result);
    if (summary) out.info(summary);
    return result;
  }

  if (liveProgress()) {
    const { running } = await import("./ink-prompts.ts");
    return running(label, async (report) => {
      current = report;
      try {
        return await task(report);
      } finally {
        current = undefined;
      }
    }, done);
  }

  const started = Date.now();
  let last = started;
  out.progress?.(`${label}...`);
  current = (detail) => {
    const now = Date.now();
    if (now - last < PLAIN_EVERY) return;
    last = now;
    out.progress?.(`${label}: ${detail} (${elapsed(now - started)})`);
  };
  try {
    const result = await task(current);
    const summary = done?.(result);
    if (summary) out.info(summary);
    return result;
  } finally {
    current = undefined;
  }
}

/** A heading for one stage of a longer run, like "Step 2 of 4: Connected services". Live only. */
export function stage(out: Output, number: number, total: number, title: string): void {
  if (liveProgress()) out.info(`\n${styleText("dim", `Step ${number} of ${total}:`)} ${styleText("bold", title)}`);
}

/** Counts work as it finishes, reporting "12 of 40 tickets". Returns the function to call for each one. */
export function tally(progress: (detail: string) => void, total: number, noun: string, plural?: string, prefix = ""): () => void {
  let done = 0;
  progress(`${prefix}0 of ${count(total, noun, plural)}`);
  return () => progress(`${prefix}${++done} of ${count(total, noun, plural)}`);
}

/** "1 board", "3 boards". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}
