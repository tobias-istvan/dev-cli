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

/**
 * How well a typed term matches a choice: null for no match, higher for closer. Every word
 * typed has to match, in order of its letters but not necessarily together, so "dsgn sys"
 * finds "Design System". Whole-word and start-of-word matches rank first.
 */
export function fuzzyScore(term: string, text: string): number | null {
  const haystack = text.toLowerCase();
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  let total = 0;
  for (const word of words) {
    const at = haystack.indexOf(word);
    if (at !== -1) {
      const startOfWord = at === 0 || /[^a-z0-9]/.test(haystack.charAt(at - 1));
      total += 100 + (startOfWord ? 50 : 0) + (at === 0 ? 25 : 0);
      continue;
    }
    // Letters in order, with gaps: fewer and shorter gaps score higher.
    let position = -1;
    let gaps = 0;
    for (const letter of word) {
      const next = haystack.indexOf(letter, position + 1);
      if (next === -1) return null;
      if (position !== -1 && next > position + 1) gaps += next - position - 1;
      position = next;
    }
    total += Math.max(1, 60 - gaps);
  }
  return total;
}

/** Choices ranked by how well they match, best first. Ties keep their original order. */
export function rank<T extends { name: string; description?: string }>(term: string, choices: T[]): T[] {
  return choices
    .map((choice, order) => ({ choice, order, score: fuzzyScore(term, `${choice.name} ${choice.description ?? ""}`) }))
    .filter((entry): entry is { choice: T; order: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.choice);
}

/** Choosing from a long list by typing any part of a name, ranked by how close it is. */
export async function search<T extends string>(message: string, choices: Array<{ value: T; name: string; description?: string }>, flag: string): Promise<T> {
  requireTerminal(flag);
  const { search: ask } = await import("@inquirer/prompts");
  return ask({ message, pageSize: 12, source: (term) => rank(term ?? "", choices) });
}

/**
 * Like search, but asks the service as you type, for lists too long to load, like every
 * page in a Confluence space. Results are ranked the same way.
 */
export async function searchRemote<T extends string>(
  message: string,
  find: (term: string) => Promise<Array<{ value: T; name: string; description?: string }>>,
  flag: string,
): Promise<T> {
  requireTerminal(flag);
  const { search: ask } = await import("@inquirer/prompts");
  return ask({
    message,
    pageSize: 12,
    source: async (term, { signal }) => {
      // Wait for a pause in typing, so each keystroke isn't a request.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (signal.aborted) return [];
      return rank(term ?? "", await find(term ?? ""));
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

export async function ask(message: string, flag: string, initial?: string): Promise<string> {
  requireTerminal(flag);
  const { input } = await import("@inquirer/prompts");
  return input({ message, default: initial, required: true });
}
