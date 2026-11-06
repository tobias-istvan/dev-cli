import { existsSync } from "node:fs";
import path from "node:path";
import { DevError } from "./output.ts";

export const CONFIG_FILE = "dev.yaml";

/** The nearest folder at or above `start` holding dev.yaml, or null. */
export function findWorkspaceRoot(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireWorkspaceRoot(start = process.cwd()): string {
  const root = findWorkspaceRoot(start);
  if (!root) {
    throw new DevError(
      `This isn't a dev workspace: no ${CONFIG_FILE} here or in any folder above.`,
      'Run this inside a workspace, or create one with "dev init".',
    );
  }
  return root;
}
