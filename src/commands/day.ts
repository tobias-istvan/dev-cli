import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import type { Output } from "../plugins/types.ts";
import { buildSnapshot, today, updateBase, writeSummary } from "../core/day.ts";
import { loadConfig, type ProjectConfig } from "../core/project-config.ts";
import { DevError } from "../core/output.ts";
import { step } from "../core/progress.ts";
import { describeRefresh, markRefresh, refreshState, snapshotTime, time } from "../core/refresh.ts";
import { enabledServices } from "../core/scaffold.ts";
import { repositoryDir } from "../core/worktree.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";
import { syncServices } from "./sync.ts";

export async function runDayStart(registry: Registry, out: Output, options: { sync: boolean; referenced: boolean }): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  let ok = true;

  const state = refreshState(root);
  if (state.running && options.sync) {
    throw new DevError(`A sync is already running: ${describeRefresh(state.refresh)}.`, 'Wait for it: "dev day status" says when it\'s done.');
  }
  const clear = options.sync ? markRefresh(root, "dev day start") : () => {};
  try {
    ok = await refresh(root, config, registry, out, options);
  } finally {
    clear();
  }
  if (!ok) process.exitCode = 1;
}

async function refresh(root: string, config: ProjectConfig, registry: Registry, out: Output, options: { sync: boolean; referenced: boolean }): Promise<boolean> {
  let ok = true;
  if (options.sync) {
    if (existsSync(path.join(repositoryDir(root), ".git"))) {
      try {
        await step(out, "Updating the code", () => updateBase(root), (update) =>
          !update.fetched
            ? `Code: the clone in repository/ has no remote, so there was nothing to fetch. Worktrees start from the local ${update.branch}.`
            : update.skipped
            ? `Code: fetched. Left ${update.branch} as it was, because ${update.skipped}.`
            : `Code: ${update.branch} ${update.advanced > 0 ? `moved on by ${update.advanced} commit${update.advanced === 1 ? "" : "s"}` : "is current"}.`,
        );
      } catch (error) {
        ok = false;
        out.warn(`Code: couldn't update. ${(error as Error).message}`);
      }
    }
    ok = (await syncServices(root, config, registry, out, enabledServices(config, registry), { referenced: options.referenced })) && ok;
  }

  const snapshot = await step(out, "Writing snapshot.md", () => buildSnapshot(root, config, registry, out, today()));
  await writeFile(path.join(root, "snapshot.md"), snapshot);
  out.info(`${ok ? "Done" : "Done, with failures"}: wrote snapshot.md.${options.sync ? " Review the synced changes before committing them." : ""}`);
  return ok;
}

export function runDayStatus(out: Output): void {
  const root = requireWorkspaceRoot();
  const state = refreshState(root);
  const snapshot = snapshotTime(root);
  const written = snapshot ? `snapshot.md was written ${snapshot.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.` : "There's no snapshot.md yet.";
  if (state.running) {
    out.info(`A sync is running: ${describeRefresh(state.refresh)}. ${written}`);
    if (state.refresh.command === "dev day start") out.info("snapshot.md is rewritten when it ends. A background one logs to .dev/state/day-start.log.");
    return;
  }
  if (state.interrupted) out.info(`${state.interrupted.command ?? "A sync"}, started at ${time(state.interrupted.started)}, stopped before finishing. The next sync takes over its lock.`);
  out.info(`No sync is running. ${written}`);
}

export async function runDayEnd(registry: Registry, out: Output, options: { date?: string }): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const date = options.date ?? today();
  const { saveSessions } = await import("../core/sessions/index.ts");
  const sessions = await saveSessions(root, registry, out, date);
  const file = await writeSummary(root, config, registry, out, date, sessions);
  out.info(`Done: ${path.relative(root, file)} is up to date. Fill in What happened, Decisions, Next steps and Blocked.`);
}
