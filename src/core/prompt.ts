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

/**
 * Which look the questions have. "ink" is an experiment, turned on by dev init alone through
 * withInkPrompts. DEV_PROMPTS=classic turns it off.
 */
let style: "classic" | "ink" = "classic";

/** Asks every question `task` asks with ink, then goes back to the classic look. */
export async function withInkPrompts<R>(task: () => Promise<R>): Promise<R> {
  const previous = style;
  style = process.env.DEV_PROMPTS === "classic" ? "classic" : "ink";
  try {
    return await task();
  } finally {
    style = previous;
  }
}

const ink = () => import("./ink-prompts.ts");

/** Whether questions and progress are drawn with ink right now. */
export function usingInk(): boolean {
  return style === "ink" && Boolean(process.stdout.isTTY);
}

/** Lists longer than this are searched by typing rather than scrolled through. */
const SHORT_LIST = 8;

export async function choose<T extends string>(message: string, choices: Array<{ value: T; name: string; description?: string }>, flag: string): Promise<T> {
  if (choices.length > SHORT_LIST) return search(message, choices, flag);
  requireTerminal(flag);
  if (style === "ink") return (await ink()).pickOne(message, choices, rank);
  const { select } = await import("@inquirer/prompts");
  return select({ message, choices });
}

/** Choosing several: type to filter, Tab to pick, Enter when done. With `optional`, none is an answer. */
export async function chooseMany<T extends string>(message: string, choices: Array<{ value: T; name: string; description?: string; checked?: boolean }>, flag: string, optional = false): Promise<T[]> {
  requireTerminal(flag);
  if (style === "ink") return (await ink()).pickMany(message, choices, rank, optional);
  const { searchMany } = await import("./search-many.ts");
  return searchMany({ message, choices, rank, optional }) as Promise<T[]>;
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
    // Letters in order, with gaps: fewer and shorter gaps score higher. A gap that lands on
    // the start of a word is free, so "gh-cli" finds "github-command-line-interface", but
    // letters scattered across a long name don't match at all.
    let position = -1;
    let gaps = 0;
    for (const letter of word) {
      const next = haystack.indexOf(letter, position + 1);
      if (next === -1) return null;
      const startOfWord = next === 0 || /[^a-z0-9]/.test(haystack.charAt(next - 1));
      if (position !== -1 && next > position + 1 && !startOfWord) gaps += next - position - 1;
      position = next;
    }
    if (gaps > Math.max(4, word.length * 2)) return null;
    total += Math.max(1, 60 - gaps);
  }
  return total;
}

/**
 * Choices ranked by how well they match, best first. A match in the name beats one that
 * needs the description. Ties keep their original order.
 */
export function rank<T extends { name: string; description?: string }>(term: string, choices: T[]): T[] {
  const score = (choice: T): number | null => {
    const name = fuzzyScore(term, choice.name);
    return name !== null ? name + 1000 : fuzzyScore(term, `${choice.name} ${choice.description ?? ""}`);
  };
  return choices
    .map((choice, order) => ({ choice, order, score: score(choice) }))
    .filter((entry): entry is { choice: T; order: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.choice);
}

/** Choosing from a long list by typing any part of a name, ranked by how close it is. */
export async function search<T extends string>(message: string, choices: Array<{ value: T; name: string; description?: string }>, flag: string): Promise<T> {
  requireTerminal(flag);
  if (style === "ink") return (await ink()).pickOne(message, choices, rank);
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
  if (style === "ink") return (await ink()).pickRemote(message, find, rank);
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
  if (style === "ink") return (await ink()).text(message, { mask: true });
  const { password } = await import("@inquirer/prompts");
  return password({ message, mask: "*" });
}

export async function confirm(message: string, flag: string, initial = true): Promise<boolean> {
  requireTerminal(flag);
  if (style === "ink") return (await ink()).yesNo(message, initial);
  const { confirm: ask } = await import("@inquirer/prompts");
  return ask({ message, default: initial });
}

export async function ask(message: string, flag: string, initial?: string): Promise<string> {
  requireTerminal(flag);
  if (style === "ink") return (await ink()).text(message, { initial, required: true });
  const { input } = await import("@inquirer/prompts");
  return input({ message, default: initial, required: true });
}
