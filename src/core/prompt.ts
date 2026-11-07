import { DevError } from "./output.ts";

/**
 * Questions for a person at a terminal. Loaded only when asked, so commands that never
 * prompt start quickly. Each throws a clear error when nobody is there to answer, so
 * scripts and agents get told which flag to use instead.
 */

function requireTerminal(flag: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new DevError("This needs an answer, and there's no terminal to ask in.", `Pass ${flag} instead.`);
  }
}

export async function choose<T extends string>(message: string, choices: Array<{ value: T; name: string; description?: string }>, flag: string): Promise<T> {
  requireTerminal(flag);
  const { select } = await import("@inquirer/prompts");
  return select({ message, choices });
}

export async function chooseMany<T extends string>(message: string, choices: Array<{ value: T; name: string; checked?: boolean }>, flag: string): Promise<T[]> {
  requireTerminal(flag);
  const { checkbox } = await import("@inquirer/prompts");
  return checkbox({ message, choices });
}

/** Choosing from a long list by typing part of a name. */
export async function search<T extends string>(message: string, choices: Array<{ value: T; name: string; description?: string }>, flag: string): Promise<T> {
  requireTerminal(flag);
  const { search: ask } = await import("@inquirer/prompts");
  return ask({
    message,
    pageSize: 12,
    source: (term) => {
      const words = (term ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      return choices.filter((choice) => words.every((word) => `${choice.name} ${choice.description ?? ""}`.toLowerCase().includes(word)));
    },
  });
}

export async function secret(message: string, flag: string): Promise<string> {
  requireTerminal(flag);
  const { password } = await import("@inquirer/prompts");
  return password({ message, mask: "*" });
}

export async function confirm(message: string, flag: string, initial = true): Promise<boolean> {
  requireTerminal(flag);
  const { confirm: ask } = await import("@inquirer/prompts");
  return ask({ message, default: initial });
}
