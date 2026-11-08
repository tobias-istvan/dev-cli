import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A marker that a sync is running, from `dev day start` or `dev sync`, so people, agents and
 * the session hook can tell, instead of guessing from process lists. It holds the command,
 * process id and start time, and is removed when the sync ends. A marker whose process is
 * gone means it was killed. Only one sync runs at a time: two would write the same files.
 */

export interface Refresh {
  pid: number;
  started: string;
  /** Like "dev day start" or "dev sync jira". */
  command: string;
}

function markerFile(root: string): string {
  return path.join(root, ".dev", "state", "sync.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type RefreshState = { running: true; refresh: Refresh } | { running: false; interrupted: Refresh | null };

/** Whether a refresh is running. A marker left by a killed one is cleared and reported. */
export function refreshState(root: string): RefreshState {
  const file = markerFile(root);
  if (!existsSync(file)) return { running: false, interrupted: null };
  let refresh: Refresh;
  try {
    refresh = JSON.parse(readFileSync(file, "utf8")) as Refresh;
  } catch {
    rmSync(file, { force: true });
    return { running: false, interrupted: null };
  }
  if (Number.isInteger(refresh.pid) && alive(refresh.pid)) return { running: true, refresh };
  rmSync(file, { force: true });
  return { running: false, interrupted: refresh };
}

/** Marks a refresh as running, and returns a function that clears the mark. */
export function markRefresh(root: string, command: string): () => void {
  const file = markerFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString(), command }, null, 2)}\n`);
  return () => {
    try {
      if ((JSON.parse(readFileSync(file, "utf8")) as Refresh).pid === process.pid) rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
}

/** "dev day start, since 15:46": what's running, for messages. */
export function describeRefresh(refresh: Refresh): string {
  return `${refresh.command ?? "a sync"}, since ${time(refresh.started)}`;
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** When snapshot.md was last written, if it exists. */
export function snapshotTime(root: string): Date | null {
  try {
    return statSync(path.join(root, "snapshot.md")).mtime;
  } catch {
    return null;
  }
}
