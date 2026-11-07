import type { Registry } from "../plugins/registry.ts";
import type { Output, ServiceEntry, SyncReport } from "../plugins/types.ts";
import { workspaceServiceContext } from "../core/context.ts";
import { DevError } from "../core/output.ts";
import type { ProjectConfig } from "../core/project-config.ts";
import { loadConfig } from "../core/project-config.ts";
import { enabledServices } from "../core/scaffold.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";

function describe(report: SyncReport): string {
  const parts = [`${report.added} new`, `${report.updated} updated`, `${report.removed} removed`];
  if (report.failed.length > 0) parts.push(`${report.failed.length} failed`);
  return parts.join(", ");
}

/** Syncs services one after another. One failing never stops the rest. Returns whether all succeeded. */
export async function syncServices(root: string, config: ProjectConfig, registry: Registry, out: Output, entries: ServiceEntry[]): Promise<boolean> {
  let ok = true;
  for (const entry of entries) {
    const sync = entry.service.sync;
    if (!sync) continue;
    try {
      const report = await sync(workspaceServiceContext(root, entry, config, registry, out), { full: false });
      out.info(`${entry.service.title}: ${describe(report)}.`);
      for (const failure of report.failed) out.warn(`  ${failure.id}: ${failure.reason}`);
      if (report.failed.length > 0) ok = false;
    } catch (error) {
      ok = false;
      const fix = (error as { fix?: string }).fix;
      out.warn(`${entry.service.title}: failed. ${(error as Error).message}${fix ? ` ${fix}` : ""}`);
    }
  }
  return ok;
}

export async function runSync(registry: Registry, out: Output, only?: string): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const enabled = enabledServices(config, registry).filter((entry) => entry.service.sync);
  const targets = only ? enabled.filter((entry) => entry.service.id === only || entry.key === only) : enabled;

  if (only && targets.length === 0) throw new DevError(`"${only}" isn't an enabled service that syncs.`, 'Run "dev doctor" to see what is enabled.');
  if (targets.length === 0) {
    out.info("Nothing to sync: no enabled service syncs anything.");
    return;
  }
  const ok = await syncServices(root, config, registry, out, targets);
  out.info(ok ? "Done: synced. Review the changes before committing them." : "Done, with failures. Run it again to retry.");
  if (!ok) process.exitCode = 1;
}
