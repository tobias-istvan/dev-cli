import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteSync, createOnly, safePath } from "./files.ts";
import { packageDir } from "./paths.ts";

/**
 * INSTRUCTIONS.md: the workspace's own instructions for agents, written by people.
 * AGENTS.md points to it and CLAUDE.md imports it, so editing it never stops dev from
 * updating those. dev creates a stub once, at init, and never writes, changes or removes
 * it after that, even if someone deletes it.
 */

export const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

/** The files that are the person's, and that dev created or found once. Committed with .dev/. */
const YOURS = path.join(".dev", "yours.json");

function readYours(root: string): string[] {
  try {
    const files = (JSON.parse(readFileSync(safePath(root, YOURS), "utf8")) as { files?: unknown }).files;
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
  } catch {
    return [];
  }
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the stub the first time, if there's no INSTRUCTIONS.md. A file already there,
 * even a symlink, is the person's and stays as it is. Once dev has created or found it,
 * it never creates it again.
 */
export async function createInstructionsOnce(root: string): Promise<"created" | "found" | "left alone"> {
  const yours = readYours(root);
  if (yours.includes(INSTRUCTIONS_FILE)) return "left alone";

  let result: "created" | "found" = "found";
  // Checked without safePath, which refuses symlinks: a symlinked file is the person's to keep.
  if (!exists(path.join(root, INSTRUCTIONS_FILE))) {
    const stub = readFileSync(path.join(packageDir(), "templates", "workspace", INSTRUCTIONS_FILE), "utf8");
    if (await createOnly(safePath(root, INSTRUCTIONS_FILE), stub)) result = "created";
  }
  atomicWriteSync(safePath(root, YOURS), `${JSON.stringify({ files: [...yours, INSTRUCTIONS_FILE].sort() }, null, 2)}\n`);
  return result;
}

export type InstructionsState = "missing" | "empty" | "stub" | "written";

/** Whether INSTRUCTIONS.md says anything: a stub is only headings and comments. */
export function instructionsState(root: string): InstructionsState {
  let text: string;
  try {
    text = readFileSync(path.join(root, INSTRUCTIONS_FILE), "utf8");
  } catch {
    return "missing";
  }
  if (!text.trim()) return "empty";
  const said = text
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .split("\n")
    .filter((line) => line.trim() && !/^\s{0,3}#{1,6}(\s|$)/.test(line));
  return said.length === 0 ? "stub" : "written";
}
