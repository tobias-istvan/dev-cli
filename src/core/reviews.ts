import { createHash } from "node:crypto";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteSync, safePath } from "./files.ts";

/** Bind the review contents to the downloaded revision at which they were written. */
export function reviewCurrent(root: string, id: string, review: string, revision: string): boolean {
  if (!existsSync(review)) return false;
  const hash = createHash("sha256").update(readFileSync(review)).digest("hex");
  const file = safePath(root, path.relative(root, path.join(path.dirname(review), `.dev-review-${id}.json`)));
  let recorded: { hash: string; revision: string } | null = null;
  try { recorded = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (!recorded || recorded.hash !== hash) {
    atomicWriteSync(file, JSON.stringify({ hash, revision }));
    return true;
  }
  return recorded.revision === revision;
}
