import { closeSync, fstatSync, openSync, writeSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { DevError } from "./output.ts";
import { safePath } from "./files.ts";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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
  return safePath(root, ".dev/state/sync.json");
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

/** Whether a refresh is running. A marker left by a killed one is reported without deleting it. */
export function refreshState(root: string): RefreshState {
  const file = markerFile(root);
  if (!existsSync(file)) return { running: false, interrupted: null };
  let refresh: Refresh;
  try {
    refresh = JSON.parse(readFileSync(file, "utf8")) as Refresh;
    if (!refresh || !Number.isSafeInteger(refresh.pid) || refresh.pid <= 0 || typeof refresh.command !== "string" || !Number.isFinite(Date.parse(refresh.started))) throw new Error("Invalid sync marker");
  } catch {
    // A creator may not have finished writing its exclusive file yet.
    if (Date.now() - statSync(file).mtimeMs < 30_000) return { running: true, refresh: { pid: -1, started: statSync(file).mtime.toISOString(), command: "a sync acquiring its lock" } };
    return { running: false, interrupted: { pid: -1, started: statSync(file).mtime.toISOString(), command: "an interrupted sync" } };
  }
  if (Number.isInteger(refresh.pid) && alive(refresh.pid)) return { running: true, refresh };
  return { running: false, interrupted: refresh };
}

/** Marks a refresh as running, and returns a function that clears the mark. */
export function markRefresh(root: string, command: string, recover = false): () => void {
  const file = markerFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const state = refreshState(root);
  if (state.running) throw new DevError("A sync is already running.", "Wait for it to finish.");
  if (state.interrupted) {
    // A marker whose owner is verifiably dead is reclaimed. An unreadable one has no known owner, so
    // only an explicit recovery releases it. Status reads never unlink locks.
    if (state.interrupted.pid <= 0 && !recover) throw new DevError("An interrupted sync left an unreadable lock behind.", "Check dev day status, then run dev sync --recover to release it.");
    const inode = statSync(file).ino;
    const latest = refreshState(root);
    if (latest.running || statSync(file).ino !== inode) throw new DevError("Sync ownership changed during recovery; retry.");
    rmSync(file);
  }
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DevError("A sync is already running.");
    throw error;
  }
  const inode = fstatSync(fd).ino;
  try { writeSync(fd, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString(), command }, null, 2)}\n`); } finally { closeSync(fd); }
  const clear = () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    try {
      if (statSync(file).ino === inode && (JSON.parse(readFileSync(file, "utf8")) as Refresh).pid === process.pid) rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
  // Ctrl-C skips finally blocks, so release the marker, then die of the same signal as usual.
  const interrupt = (signal: NodeJS.Signals) => {
    clear();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  return clear;
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

/** How long a command that writes waits for a running sync: DEV_SYNC_WAIT, in seconds. */
function waitLimit(): number {
  const seconds = Number(process.env.DEV_SYNC_WAIT ?? "");
  return (process.env.DEV_SYNC_WAIT && Number.isFinite(seconds) && seconds >= 0 ? seconds : 300) * 1000;
}

/**
 * Runs a command that writes workspace files as the only writer. A sync already running,
 * like the one a new session starts in the background, is waited for rather than failed on.
 */
export async function withRefresh<T>(root: string, command: string, run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + waitLimit();
  let clear: (() => void) | null = null;
  for (let told = false; !clear; ) {
    const state = refreshState(root);
    if (state.running && Date.now() < deadline) {
      if (!told) console.error(`Waiting for a running sync to finish: ${describeRefresh(state.refresh)}.`);
      told = true;
      await sleep(500);
      continue;
    }
    try {
      clear = markRefresh(root, command);
    } catch (error) {
      // Another waiter took the lock first: wait for that one too.
      if (!(error instanceof DevError) || !refreshState(root).running || Date.now() >= deadline) throw error;
    }
  }
  try { return await run(); } finally { clear(); }
}
