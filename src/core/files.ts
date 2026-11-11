import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile, link } from "node:fs/promises";
import path from "node:path";

/** Reject traversal and symlinks at every existing component below a trusted root. */
export function safePath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Path must stay inside its folder.");
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target === base || path.relative(base, target).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(base, target))) throw new Error("Path must stay inside its folder.");
  let current = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Refusing to follow a filesystem symlink.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

/** Same-directory replacement leaves the previous complete file intact on failure. */
export function atomicWriteSync(file: string, content: string | Uint8Array, mode?: number): void {
  file = checkedDestination(file);
  mkdirSync(path.dirname(file), { recursive: true });
  let permissions = mode;
  if (permissions === undefined) { try { permissions = statSync(file).mode & 0o777; } catch {} }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: permissions ?? 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * The destination with its folder's symlinks resolved, so a home, config folder or workspace
 * reached through one works. The file itself is never followed. Staying inside a trusted
 * root is the caller's check, with safePath.
 */
function checkedDestination(file: string): string {
  file = path.resolve(file);
  let existing = path.dirname(file);
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  file = path.join(realpathSync(existing), path.relative(existing, file));
  try { if (lstatSync(file).isSymbolicLink()) throw new Error("Refusing to replace a symlink."); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

export async function atomicWrite(file: string, content: string | Uint8Array): Promise<void> {
  file = checkedDestination(file);
  await mkdir(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = (await stat(file)).mode & 0o777; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Publish a complete new file exclusively; a racing creator's file is never replaced. */
export async function createOnly(file: string, content: string): Promise<boolean> {
  file = checkedDestination(file);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    try { await link(temporary, file); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally { await rm(temporary, { force: true }); }
}
