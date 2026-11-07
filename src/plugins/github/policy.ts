import type { CommandPolicy } from "../types.ts";

/**
 * Which gh commands only read and which change something, for the command check.
 * Commands that only change your machine, like a checkout or a download, count as reads:
 * the check is about what reaches GitHub.
 */

type Kind = "read" | "change" | "unknown";
interface Call {
  command: string;
  kind: Kind;
  why: string;
}

function isRedirection(word: string): boolean {
  return /^\d*[<>]/.test(word) || /^&>/.test(word);
}

// Options gh accepts before or after the command that take a value.
const VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

// Read-only subcommands, by top-level command. Anything else under a known command
// is treated as a change.
const READ: Record<string, Set<string> | "all"> = {
  // Some only change your machine, never GitHub: checkout, clone, download.
  pr: new Set(["view", "diff", "list", "status", "checks", "checkout"]),
  issue: new Set(["view", "list", "status"]),
  repo: new Set(["view", "list", "clone", "set-default"]),
  run: new Set(["view", "list", "watch", "download"]),
  workflow: new Set(["view", "list"]),
  release: new Set(["view", "list", "download"]),
  label: new Set(["list"]),
  gist: new Set(["view", "list"]),
  secret: new Set(["list"]),
  variable: new Set(["list", "get"]),
  cache: new Set(["list"]),
  ruleset: new Set(["list", "view", "check"]),
  org: new Set(["list"]),
  project: new Set(["list", "view", "field-list", "item-list"]),
  codespace: new Set(["list", "view", "logs"]),
  attestation: new Set(["verify", "download"]),
  extension: new Set(["list", "search", "browse"]),
  alias: new Set(["list"]),
  config: new Set(["get", "list"]),
  auth: new Set(["status", "token"]),
  "ssh-key": new Set(["list"]),
  "gpg-key": new Set(["list"]),
  search: "all",
  status: "all",
  browse: "all",
  help: "all",
  version: "all",
  completion: "all",
};

const KNOWN = new Set([
  ...Object.keys(READ),
  "api", "agent-task", "copilot", "preview",
]);

function classify(args: string[], aliases: Record<string, string>, expanded = false): Call {
  const positional: string[] = [];
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h" || arg === "--version") help = true;
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (isRedirection(arg)) continue;
    positional.push(arg);
  }

  const top = positional[0];

  if (!top) {
    return { command: "", kind: "read", why: help ? "gh help" : "gh with no command shows help" };
  }

  if (!KNOWN.has(top)) {
    const alias = aliases[top];
    if (alias !== undefined && !expanded && !alias.startsWith("!")) {
      const rest = args.slice(args.indexOf(top) + 1);
      const call = classify([...alias.split(/\s+/), ...rest], aliases, true);
      return { ...call, why: `${top} is an alias for "${alias}". ${call.why}` };
    }
    return {
      command: top,
      kind: "unknown",
      why: alias?.startsWith("!") ? `${top} is a shell alias` : `${top} isn't a gh command this check knows: an extension or alias`,
    };
  }

  // Help never changes anything, whatever the command. Callers treat it as a plain read.
  if (help) return { command: "help", kind: "read", why: "help only" };

  if (top === "api") return classifyApi(args);

  const sub = positional[1];
  const reads = READ[top];
  const command = sub ? `${top} ${sub}` : top;

  if (reads === "all") return { command: top, kind: "read", why: "read-only command" };
  if (!sub) return { command: top, kind: "read", why: "shows help" };
  if (reads?.has(sub)) {
    if (top === "auth" && sub === "token") return { command, kind: "read", why: "prints the GitHub token" };
    return { command, kind: "read", why: "read-only command" };
  }
  if (reads) return { command, kind: "change", why: "changes something" };
  return { command, kind: "unknown", why: "not a command this check knows" };
}

function classifyApi(args: string[]): Call {
  let method: string | null = null;
  let hasFields = false;
  let input = false;
  let endpoint: string | null = null;
  const fields: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const value = (): string => args[++i] ?? "";
    const inline = arg.includes("=") && arg.startsWith("--") ? arg.slice(arg.indexOf("=") + 1) : null;

    if (arg === "-X" || arg === "--method") method = value().toUpperCase();
    else if (arg.startsWith("--method=")) method = (inline ?? "").toUpperCase();
    else if (/^-X[A-Za-z]+$/.test(arg)) method = arg.slice(2).toUpperCase();
    else if (["-f", "-F", "--field", "--raw-field"].includes(arg)) {
      hasFields = true;
      fields.push(value());
    } else if (/^--(field|raw-field)=/.test(arg)) {
      hasFields = true;
      fields.push(inline ?? "");
    } else if (arg === "--input") {
      input = true;
      value();
    } else if (["-H", "--header", "-q", "--jq", "-t", "--template", "--cache", "--hostname", "-p", "--preview"].includes(arg)) {
      value();
    } else if (!arg.startsWith("-") && endpoint === null && arg !== "api") {
      endpoint = arg;
    }
  }

  if (endpoint === "graphql") {
    const query = fields.find((f) => /^query=/.test(f));
    if (!query) return { command: "api", kind: "unknown", why: "a GraphQL call whose query can't be seen" };
    const text = query.slice("query=".length);
    if (text.startsWith("@")) return { command: "api", kind: "unknown", why: "a GraphQL query read from a file" };
    if (/(^|\})\s*mutation\b/.test(text)) {
      return { command: "api", kind: "change", why: "a GraphQL mutation" };
    }
    return { command: "api", kind: "read", why: "a GraphQL query" };
  }

  const effective = method ?? (hasFields || input ? "POST" : "GET");
  if (effective === "GET" || effective === "HEAD") {
    return { command: "api", kind: "read", why: `a ${effective} request` };
  }
  return {
    command: "api",
    kind: "change",
    why: method ? `a ${effective} request` : "fields make it a POST request",
  };
}


/** Expands the person's gh aliases, like co → pr checkout, when given. */
export function classifyGh(args: string[], aliases: Record<string, string> = {}): Call {
  return classify(args, aliases);
}

export const ghPolicy: CommandPolicy = {
  executables: ["gh"],
  classify: (args) => classify(args, {}),
};
