import type { Registry } from "../plugins/registry.ts";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Output, Reference, ServiceEntry, SyncReport } from "../plugins/types.ts";
import { workspaceServiceContext } from "../core/context.ts";
import { DevError, OutsideScope } from "../core/output.ts";
import type { ProjectConfig } from "../core/project-config.ts";
import { loadConfig } from "../core/project-config.ts";
import { enabledServices } from "../core/scaffold.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";

function describe(report: SyncReport): string {
  const parts = [`${report.added} new`, `${report.updated} updated`, `${report.removed} removed`];
  if (report.failed.length > 0) parts.push(`${report.failed.length} failed`);
  return parts.join(", ");
}

export interface SyncOptions {
  /** Only keep what tasks point to up to date, for services that aren't task sources. */
  referenced: boolean;
}

/** Whether a service syncs only what's referenced: task sources always sync in full. */
function referencedMode(config: ProjectConfig, entry: ServiceEntry, options: SyncOptions): boolean {
  if (entry.service.tasks || entry.service.role !== "connected") return false;
  return options.referenced || config.services.find((s) => s.service === entry.key)?.sync === "referenced";
}

/**
 * Fetches what open tasks and PRs point to, from every service that isn't a task source.
 * Each service only fetches within its scope unless told otherwise, and items already here
 * are left for the sync itself.
 */
async function sweep(root: string, config: ProjectConfig, registry: Registry, out: Output, entries: ServiceEntry[]): Promise<void> {
  const enabled = enabledServices(config, registry);
  // Each text with where it came from, so a link outside the scope can say who points to it.
  const texts: Array<{ source: string; text: string }> = [];
  for (const entry of enabled) {
    if (!entry.service.tasks) continue;
    try {
      for (const task of await entry.service.tasks.list(workspaceServiceContext(root, entry, config, registry, out))) {
        if (task.done) continue;
        for (const file of [task.file, ...(task.related ?? [])]) {
          if (existsSync(path.join(root, file))) texts.push({ source: file === task.file ? task.id : path.basename(path.dirname(file)), text: await readFile(path.join(root, file), "utf8") });
        }
      }
    } catch {
      // A task source that can't list its tasks only means fewer references.
    }
  }
  // Open PRs under review point to tickets and specs too.
  const pulls = path.join(root, "pull-requests");
  if (existsSync(pulls)) {
    for (const name of await readdir(pulls)) {
      const file = path.join(pulls, name, "pr-description.md");
      if (/^\d+$/.test(name) && existsSync(file)) {
        const text = await readFile(file, "utf8");
        if (/^status: (open|draft)$/m.test(text)) texts.push({ source: `PR #${name}`, text });
      }
    }
  }
  if (texts.length === 0) return;

  for (const entry of entries) {
    const links = entry.service.links;
    if (!links || entry.service.tasks || entry.service.role !== "connected") continue;
    const context = workspaceServiceContext(root, entry, config, registry, out);
    // Every reference once, with every source pointing to it.
    const references = new Map<string, { reference: Reference; sources: Set<string> }>();
    for (const { source, text } of texts) {
      for (const reference of links.find(text, context.scope)) {
        const known = references.get(reference.id) ?? { reference, sources: new Set<string>() };
        known.sources.add(source);
        references.set(reference.id, known);
      }
    }

    let fetched = 0;
    const outside: Array<{ link: string; sources: string[] }> = [];
    for (const { reference, sources } of references.values()) {
      try {
        const before = await localFiles(root, entry.service.id);
        await links.fetch(context, reference);
        if ((await localFiles(root, entry.service.id)) > before) fetched++;
      } catch (error) {
        if (error instanceof OutsideScope) outside.push({ link: reference.url ?? reference.id, sources: [...sources].sort() });
        else out.warn(`  ${entry.service.title}: couldn't fetch ${reference.id}. ${(error as Error).message}`);
      }
    }
    if (fetched > 0) out.info(`${entry.service.title}: ${fetched} new from references.`);
    if (outside.length > 0) {
      out.info(`${entry.service.title}: ${outside.length} linked item${outside.length === 1 ? " is" : "s are"} outside the scope, so not fetched:`);
      for (const item of outside) out.info(`  ${item.link}\n    linked from ${item.sources.join(", ")}`);
      out.info(
        entry.service.scope.add
          ? `  To include one: dev ${entry.service.id} scope add <link>. Or set "fetch: anywhere" for ${entry.service.id} in dev.yaml.`
          : `  To include one, change the scope with "dev ${entry.service.id} scope", or set "fetch: anywhere" for ${entry.service.id} in dev.yaml.`,
      );
    }
  }
}

async function localFiles(root: string, folder: string): Promise<number> {
  try {
    return (await readdir(path.join(root, folder), { recursive: true })).length;
  } catch {
    return 0;
  }
}

/** Syncs services one after another, then follows what the tasks point to. One failing never stops the rest. */
export async function syncServices(root: string, config: ProjectConfig, registry: Registry, out: Output, entries: ServiceEntry[], options: SyncOptions = { referenced: false }): Promise<boolean> {
  let ok = true;
  for (const entry of entries) {
    const referenced = referencedMode(config, entry, options);
    const run = referenced ? entry.service.refresh : entry.service.sync;
    if (!run) {
      if (referenced && entry.service.sync) out.info(`${entry.service.title}: skipped, it can only sync in full.`);
      continue;
    }
    try {
      const report = await run(workspaceServiceContext(root, entry, config, registry, out), { full: false });
      out.info(`${entry.service.title}${referenced ? " (referenced only)" : ""}: ${describe(report)}.`);
      for (const failure of report.failed) out.warn(`  ${failure.id}: ${failure.reason}`);
      if (report.failed.length > 0) ok = false;
    } catch (error) {
      ok = false;
      const fix = (error as { fix?: string }).fix;
      out.warn(`${entry.service.title}: failed. ${(error as Error).message}${fix ? ` ${fix}` : ""}`);
    }
  }
  await sweep(root, config, registry, out, entries);
  return ok;
}

export async function runSync(registry: Registry, out: Output, only: string | undefined, options: SyncOptions): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const enabled = enabledServices(config, registry).filter((entry) => entry.service.sync || entry.service.refresh);
  const targets = only ? enabled.filter((entry) => entry.service.id === only || entry.key === only) : enabled;

  if (only && targets.length === 0) throw new DevError(`"${only}" isn't an enabled service that syncs.`, 'Run "dev doctor" to see what is enabled.');
  if (targets.length === 0) {
    out.info("Nothing to sync: no enabled service syncs anything.");
    return;
  }
  const ok = await syncServices(root, config, registry, out, targets, options);
  out.info(ok ? "Done: synced. Review the changes before committing them." : "Done, with failures. Run it again to retry.");
  if (!ok) process.exitCode = 1;
}
