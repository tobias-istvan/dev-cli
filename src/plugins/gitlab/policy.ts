import type { CommandPolicy } from "../types.ts";

/**
 * Which glab commands only read and which change something, for the command check. Like
 * gh's: commands that only change your machine, like a checkout, count as reads.
 */

const VALUE_FLAGS = new Set(["-R", "--repo", "--hostname", "-g", "--group"]);
const READ: Record<string, Set<string> | "all"> = {
  mr: new Set(["view", "list", "diff", "checkout"]),
  issue: new Set(["view", "list"]),
  repo: new Set(["view", "list", "clone", "search"]),
  ci: new Set(["view", "list", "status", "trace", "get"]),
  pipeline: new Set(["view", "list", "status", "ci"]),
  release: new Set(["view", "list", "download"]),
  label: new Set(["list"]),
  variable: new Set(["list", "get"]),
  snippet: new Set(["view", "list"]),
  auth: new Set(["status"]),
  config: new Set(["get"]),
  alias: new Set(["list"]),
  help: "all",
  version: "all",
  completion: "all",
};

function classifyApi(args: string[]): { command: string; kind: "read" | "change"; why: string } {
  const at = args.findIndex((a) => a === "-X" || a === "--method");
  const method = (at >= 0 ? args[at + 1] : args.find((a) => a.startsWith("--method="))?.slice(9))?.toUpperCase();
  const fields = args.some((a) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(field|raw-field)=/.test(a));
  const effective = method ?? (fields ? "POST" : "GET");
  return effective === "GET" || effective === "HEAD"
    ? { command: "api", kind: "read", why: `a ${effective} request` }
    : { command: "api", kind: "change", why: method ? `a ${effective} request` : "fields make it a POST request" };
}

export const glabPolicy: CommandPolicy = {
  executables: ["glab"],
  classify(args) {
    if (args.includes("--help") || args.includes("-h")) return { command: "help", kind: "read", why: "help only" };
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (VALUE_FLAGS.has(arg)) i++;
      else if (!arg.startsWith("-")) positional.push(arg);
    }
    const [top, sub] = positional;
    if (!top) return { command: "", kind: "read", why: "shows help" };
    if (top === "api") return classifyApi(args);
    const reads = READ[top];
    if (!reads) return { command: top, kind: "unknown", why: "not a glab command this check knows" };
    if (reads === "all" || !sub) return { command: top, kind: "read", why: "read-only command" };
    return reads.has(sub) ? { command: `${top} ${sub}`, kind: "read", why: "read-only command" } : { command: `${top} ${sub}`, kind: "change", why: "changes something" };
  },
};
