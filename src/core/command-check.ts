import { readFileSync } from "node:fs";
import path from "node:path";
import type { Mark, Plugin } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { configDir } from "./paths.ts";

/**
 * The command check: before an agent runs a shell command, decides whether it may run,
 * needs the person's approval, or is blocked. Each plugin classifies its own CLI, like gh,
 * and dev's own service commands carry a read or change mark. Commands nobody knows are
 * left to the tool's own permissions.
 *
 * A guardrail, not a security boundary: an agent runs as the person, so a script could
 * still reach a service another way. It catches the ordinary case and hands that decision
 * to the person.
 */

export type Decision = "allow" | "ask" | "deny";
export type Kind = Mark | "unknown";

export interface Policy {
  read: Decision;
  change: Decision;
  unknown: Decision;
  /** Per-command decisions, like "gh pr create": "allow". The longest match wins. */
  commands: Record<string, Decision>;
}

export const DEFAULT_POLICY: Policy = {
  read: "allow",
  change: "ask",
  unknown: "ask",
  // Read-only, but it prints a token into the agent's context.
  commands: { "gh auth token": "deny" },
};

export interface Call {
  /** The executable and command words, like "gh pr view" or "dev github prs". */
  command: string;
  kind: Kind;
  why: string;
}

export interface Verdict {
  /** null: no opinion, so the tool decides as usual. */
  decision: Decision | null;
  calls: Array<Call & { decision: Decision; rule: string }>;
  reason: string;
}

export function policyFile(): string {
  return path.join(configDir(), "policy.json");
}

const DECISIONS = new Set(["allow", "ask", "deny"]);

/** The person's policy over the defaults. A broken file never loosens anything. */
export function loadPolicy(file = policyFile()): { policy: Policy; problem: string | null } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { policy: DEFAULT_POLICY, problem: null };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pick = (value: unknown, fallback: Decision): Decision => (typeof value === "string" && DECISIONS.has(value) ? (value as Decision) : fallback);
    const commands: Record<string, Decision> = { ...DEFAULT_POLICY.commands };
    if (parsed.commands && typeof parsed.commands === "object") {
      for (const [key, value] of Object.entries(parsed.commands)) {
        if (typeof value === "string" && DECISIONS.has(value)) commands[key.trim().split(/\s+/).join(" ")] = value as Decision;
      }
    }
    return {
      policy: { read: pick(parsed.read, DEFAULT_POLICY.read), change: pick(parsed.change, DEFAULT_POLICY.change), unknown: pick(parsed.unknown, DEFAULT_POLICY.unknown), commands },
      problem: null,
    };
  } catch {
    return { policy: DEFAULT_POLICY, problem: "the policy file isn't valid JSON" };
  }
}

// ---------------------------------------------------------------------------
// Shell parsing

interface Segment {
  words: string[];
  /** The segment holds $(...), backticks or <(...), which can hide a command. */
  substitution: boolean;
}

/**
 * Splits a command line into simple commands and their words, honouring quotes. It
 * is deliberately small: anything it can't follow is reported, never guessed.
 */
export function splitCommands(line: string): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let substitution = false;

  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0 || substitution) segments.push({ words, substitution });
    words = [];
    substitution = false;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);

    if (c === "\\" && i + 1 < line.length) {
      const next = line.charAt(i + 1);
      i++;
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      continue;
    }

    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      const end = close === -1 ? line.length : close;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }

    if (c === '"') {
      inWord = true;
      i++;
      while (i < line.length && line.charAt(i) !== '"') {
        const d = line.charAt(i);
        if (d === "\\" && i + 1 < line.length) {
          word += line.charAt(i + 1);
          i += 2;
          continue;
        }
        if (d === "`" || (d === "$" && line.charAt(i + 1) === "(")) substitution = true;
        word += d;
        i++;
      }
      continue;
    }

    if (c === "`" || (c === "$" && line.charAt(i + 1) === "(") || ((c === "<" || c === ">") && line.charAt(i + 1) === "(")) {
      substitution = true;
      word += c;
      inWord = true;
      continue;
    }

    if (c === "#" && !inWord) {
      // A comment runs to the end of the line.
      const newline = line.indexOf("\n", i);
      if (newline === -1) break;
      i = newline - 1;
      continue;
    }

    // Braces and brackets inside a word, like ${PR}, are part of it.
    const grouping = c === "(" || c === ")" || c === "{" || c === "}";
    if (grouping && inWord) {
      word += c;
      continue;
    }

    if (c === ";" || c === "\n" || c === "&" || c === "|" || grouping) {
      // A redirection like 2>&1 keeps its & inside the word.
      if (c === "&" && (word.endsWith(">") || word.endsWith("<"))) {
        word += c;
        continue;
      }
      endSegment();
      continue;
    }

    if (c === " " || c === "\t") {
      endWord();
      continue;
    }

    word += c;
    inWord = true;
  }

  endSegment();
  return segments;
}

// Commands that run the command after them.
const RUNNERS = new Set([
  "command", "builtin", "exec", "env", "time", "nohup", "nice", "sudo", "doas", "timeout",
  "xargs", "watch", "caffeinate", "stdbuf", "if", "then", "elif", "else", "while", "until", "do", "!",
]);
// Commands that can run a command named among their arguments.
const ARGUMENT_RUNNERS = new Set([...RUNNERS, "find", "parallel", "script", "osascript", "node", "python", "python3", "ruby", "perl"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

function isRedirection(word: string): boolean {
  return /^\d*[<>]/.test(word) || /^&>/.test(word);
}

/** The words of a segment from its real command onwards, skipping assignments and runners. */
function commandWords(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || isRedirection(word)) {
      i++;
      continue;
    }
    if (RUNNERS.has(path.basename(word))) {
      i++;
      // A runner's own options and arguments, like timeout 30 or env -i.
      while (i < words.length) {
        const next = words[i] ?? "";
        if (next.startsWith("-") || /^\d+[smhd]?$/.test(next) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) i++;
        else break;
      }
      continue;
    }
    break;
  }
  return words.slice(i);
}

// Commands that only read or move around, which an allowed gh line may also run, such
// as cd before it or head after it. Anything else leaves the line to the tool.
const SAFE = new Set(["cd", "head", "tail", "jq", "grep", "wc", "sort", "uniq", "cat", "echo", "printf", "true", "less", "cut", "column"]);

/** A redirection that writes to a file, not to the other output stream or nowhere. */
function writesFile(word: string): boolean {
  const match = word.match(/^(?:\d*|&)>>?(.*)$/);
  if (!match) return false;
  const target = match[1] ?? "";
  return !(target === "/dev/null" || /^&\d$/.test(target));
}

// ---------------------------------------------------------------------------
// Finding and judging calls

/** Classifies one call to an executable: its words after the executable. null means no opinion. */
export type Classifier = (args: string[]) => Omit<Call, "command"> & { command: string } | null;

/** The executables the check knows: each plugin's CLI, and dev itself. */
export function classifiers(registry: Registry): Map<string, Classifier> {
  const map = new Map<string, Classifier>();
  for (const plugin of registry.plugins as Plugin[]) {
    const policy = plugin.commandPolicy;
    if (!policy) continue;
    for (const executable of policy.executables) {
      map.set(executable, (args) => {
        const call = policy.classify(args);
        return { ...call, command: [executable, call.command].filter(Boolean).join(" ") };
      });
    }
  }

  // dev's own service commands carry their mark. Core commands only touch the workspace.
  map.set("dev", (args) => {
    const [first, second] = args.filter((arg) => !arg.startsWith("-"));
    if (args.includes("--help") || args.includes("-h")) return null;
    if (first === "login") return { command: "dev login", kind: "change", why: "logins are for people, not agents" };
    const entry = first ? registry.service(first) : undefined;
    const definition = entry?.service.commands?.find((c) => c.name === second);
    if (!entry || !definition) return null;
    return {
      command: `dev ${entry.service.id} ${definition.name}`,
      kind: definition.mark,
      why: definition.mark === "change" ? `changes things in ${entry.service.title}` : `only reads from ${entry.service.title}`,
    };
  });
  return map;
}

/** The executable a word runs, if the check knows it. A path counts only when it's a bin folder's, so /dev isn't dev. */
function executableOf(word: string, map: Map<string, Classifier>): string | null {
  if (map.has(word)) return word;
  const match = word.match(/\/(?:\.?bin)\/([^/]+)$/);
  return match?.[1] && map.has(match[1]) ? match[1] : null;
}

function known(word: string, map: Map<string, Classifier>): boolean {
  return executableOf(word, map) !== null;
}

export function findCalls(line: string, map: Map<string, Classifier>, depth = 0): Call[] {
  const calls: Call[] = [];
  const names = [...map.keys()];

  for (const segment of splitCommands(line)) {
    const words = commandWords(segment.words);
    const first = words[0] ?? "";
    const text = segment.words.join(" ");
    const mentioned = names.find((name) => segment.words.some((w) => executableOf(w, map) === name) || new RegExp(`(^|[\\s\`(])${name}(\\s|$)`).test(text));

    if (segment.substitution && mentioned) {
      calls.push({ command: mentioned, kind: "unknown", why: `${mentioned} inside $(...) or backticks can't be checked` });
      continue;
    }

    const executable = executableOf(first, map);
    if (executable) {
      const call = map.get(executable)?.(words.slice(1));
      if (call) calls.push(call);
      continue;
    }

    const base = path.basename(first);
    if (SHELLS.has(base) || base === "eval") {
      const flag = words.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
      const script = base === "eval" ? words.slice(1).join(" ") : flag >= 0 ? words[flag + 1] : undefined;
      if (script !== undefined && depth < 3) calls.push(...findCalls(script, map, depth + 1));
      else if (mentioned) calls.push({ command: mentioned, kind: "unknown", why: `${mentioned} run through ${base} can't be checked` });
      continue;
    }

    const argument = words.slice(1).map((w) => executableOf(w, map)).find(Boolean);
    if (argument && ARGUMENT_RUNNERS.has(base)) {
      calls.push({ command: argument, kind: "unknown", why: `${argument} run through ${base} can't be checked` });
    }
  }
  return calls;
}

const STRICTNESS: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

function decide(call: Call, policy: Policy): { decision: Decision; rule: string } {
  const words = call.command.split(" ");
  // Help is a read whatever the command, so a rule for a command never blocks its help.
  if (call.why !== "help only") {
    for (let n = words.length; n > 0; n--) {
      const key = words.slice(0, n).join(" ");
      const decision = policy.commands[key];
      if (decision) return { decision, rule: `"${key}": ${decision}` };
    }
  }
  return { decision: policy[call.kind], rule: `${call.kind}: ${policy[call.kind]}` };
}

/**
 * The verdict for one command line. It allows only when every part is an allowed call or
 * a harmless helper like cd or head; anything else in the line leaves it to the tool,
 * unless a call in it needs asking or is blocked.
 */
export function judge(line: string, policy: Policy, map: Map<string, Classifier>): Verdict {
  const calls = findCalls(line, map).map((call) => ({ ...call, ...decide(call, policy) }));
  if (calls.length === 0) return { decision: null, calls, reason: "" };

  const strictest = calls.reduce((a, b) => (STRICTNESS[b.decision] > STRICTNESS[a.decision] ? b : a));
  const describe = (call: (typeof calls)[number]): string => `${call.command}: ${call.why} (${call.rule})`;

  if (strictest.decision === "allow") {
    const contained = splitCommands(line).every((segment) => {
      if (segment.words.some(writesFile)) return false;
      const words = commandWords(segment.words);
      const first = words[0] ?? "";
      return known(first, map) || (SAFE.has(first) && !(first === "sort" && words.some((w) => w.startsWith("-o"))));
    });
    return { decision: contained ? "allow" : null, calls, reason: contained ? `dev command check: ${calls.map(describe).join("; ")}` : "" };
  }

  const prefix =
    strictest.decision === "deny"
      ? "Blocked by the person's dev command check. Don't try another way: tell the person what you wanted to run and why"
      : "dev command check: this needs the person's approval";
  return { decision: strictest.decision, calls, reason: `${prefix}. ${describe(strictest)}` };
}
