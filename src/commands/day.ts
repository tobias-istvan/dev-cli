import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import type { Output } from "../plugins/types.ts";
import { buildSnapshot, today, updateBase, writeSummary } from "../core/day.ts";
import { loadConfig } from "../core/project-config.ts";
import { enabledServices } from "../core/scaffold.ts";
import { repositoryDir } from "../core/worktree.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";
import { syncServices } from "./sync.ts";

export async function runDayStart(registry: Registry, out: Output, options: { sync: boolean }): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  let ok = true;

  if (options.sync) {
    if (existsSync(path.join(repositoryDir(root), ".git"))) {
      try {
        const update = await updateBase(root);
        out.info(
          update.skipped
            ? `Code: fetched. Left ${update.branch} as it was, because ${update.skipped}.`
            : `Code: ${update.branch} ${update.advanced > 0 ? `moved on by ${update.advanced} commit${update.advanced === 1 ? "" : "s"}` : "is current"}.`,
        );
      } catch (error) {
        ok = false;
        out.warn(`Code: couldn't update. ${(error as Error).message}`);
      }
    }
    ok = (await syncServices(root, config, registry, out, enabledServices(config, registry))) && ok;
  }

  await writeFile(path.join(root, "snapshot.md"), await buildSnapshot(root, config, registry, out, today()));
  out.info(`${ok ? "Done" : "Done, with failures"}: wrote snapshot.md.${options.sync ? " Review the synced changes before committing them." : ""}`);
  if (!ok) process.exitCode = 1;
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
