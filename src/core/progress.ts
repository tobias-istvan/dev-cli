import { styleText } from "node:util";
import type { Output } from "../plugins/types.ts";
import { usingInk } from "./prompt.ts";

/**
 * Telling a person what's happening while they wait, between questions. With ink (dev init),
 * a spinner names the work, shows how far along it is and how long it's taken, then leaves a
 * line saying what it found. Otherwise it says what it's doing, as it always has.
 */

/** Runs `task`, showing `label` while it does. The task can `report` how far it's got. */
export async function step<T>(out: Output, label: string, task: (report: (detail: string) => void) => Promise<T>, done?: (result: T) => string): Promise<T> {
  if (usingInk()) return (await import("./ink-prompts.ts")).running(label, task, done);
  out.info(`${label}...`);
  return task(() => {});
}

/** A heading for one stage of a longer run, like "Step 2 of 4: Connected services". Ink only. */
export function stage(out: Output, number: number, total: number, title: string): void {
  if (usingInk()) out.info(`\n${styleText("dim", `Step ${number} of ${total}:`)} ${styleText("bold", title)}`);
}

/** "1 board", "3 boards". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}
