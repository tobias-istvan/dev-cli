import { splitFrontMatter } from "../core/front-matter.ts";
import { buildServiceIndex, serviceFiles } from "../core/indexes.ts";
import { createLocalizer, localizeFile, readOutside, scopeCommand, writeOutside } from "../core/links.ts";
import type { Registry } from "../plugins/registry.ts";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Output, Reference, ServiceEntry, SyncReport } from "../plugins/types.ts";
import { workspaceServiceContext } from "../core/context.ts";
import { DevError, NotFound, OutsideScope } from "../core/output.ts";
import { describeRefresh, markRefresh, refreshState } from "../core/refresh.ts";
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
  recover?: boolean;
}

/** Whether a service syncs only what's referenced: task sources always sync in full. */
function referencedMode(config: ProjectConfig, entry: ServiceEntry, options: SyncOptions): boolean {
  if (entry.service.tasks || entry.service.role !== "connected") return false;
  return options.referenced || config.services.find((s) => s.service === entry.key)?.sync === "referenced";
}

/**
 * Fetches what the workspace's own items point to: open tasks, open PRs, and everything in
 * a scope, like a spec's links. Each service only fetches within its scope unless told
 * otherwise, and says which links it left out and the command that brings each one in.
 * Items already here are left for the sync itself. Links inside items that were themselves
 * fetched as links aren't followed further.
 */
async function sweep(root: string, config: ProjectConfig, registry: Registry, out: Output, entries: ServiceEntry[]): Promise<boolean> {
  let ok = true;
  const enabled = enabledServices(config, registry);
  // Each text with where it came from, so a link outside the scope can say who points to it.
  const texts: Array<{ source: string; text: string }> = [];
  const read = new Set<string>();
  const add = async (file: string, source: string): Promise<void> => {
    if (read.has(file) || !existsSync(path.join(root, file))) return;
    read.add(file);
    texts.push({ source, text: await readFile(path.join(root, file), "utf8") });
  };
  for (const entry of enabled) {
    if (entry.service.role !== "connected") continue;
    try {
      if (entry.service.tasks) {
        for (const task of await entry.service.tasks.list(workspaceServiceContext(root, entry, config, registry, out))) {
          if (task.done) continue;
          for (const file of [task.file, ...(task.related ?? [])]) await add(file, file === task.file ? task.id : path.basename(path.dirname(file)));
        }
      } else {
        for (const file of serviceFiles(root, entry.service)) {
          const { data } = splitFrontMatter(await readFile(path.join(root, file), "utf8"));
          if (data?.inScope === true) await add(file, String(data.title || data.id));
        }
      }
    } catch (error) {
      ok = false;
      out.warn(`${entry.service.title}: could not enumerate references. ${(error as Error).message}`);
    }
  }
  // Open PRs under review point to tickets and specs too.
  for (const [reviewFolder, description] of [["pull-requests", "pr-description.md"], ["merge-requests", "mr-description.md"]] as const) {
    const pulls = path.join(root, reviewFolder);
    if (existsSync(pulls)) {
      for (const name of await readdir(pulls)) {
        const file = path.join(pulls, name, description);
        if (/^\d+$/.test(name) && existsSync(file)) {
          const text = await readFile(file, "utf8");
          if (/^status: (open|draft)$/m.test(text)) texts.push({ source: `${reviewFolder === "pull-requests" ? "PR #" : "MR !"}${name}`, text });
        }
      }
    }
  }
  if (texts.length === 0) return ok;

  const state = readOutside(root);
  for (const entry of entries) {
    const links = entry.service.links;
    if (!links || entry.service.role !== "connected") continue;
    const context = workspaceServiceContext(root, entry, config, registry, out);
    context.deferIndex = true;
    // Every reference once, with every source pointing to it.
    const references = new Map<string, { reference: Reference; sources: Set<string> }>();
    for (const { source, text } of texts) {
      for (const reference of links.find(text, context)) {
        const known = references.get(reference.id) ?? { reference, sources: new Set<string>() };
        if (reference.url && !known.reference.url) known.reference = reference;
        known.sources.add(source);
        references.set(reference.id, known);
      }
    }

    const name = entry.service.index?.folder ?? entry.service.id;
    const before = await localFiles(root, name);
    let fetched = 0;
    const outside: Array<{ reference: Reference; sources: string[] }> = [];
    for (const { reference, sources } of references.values()) {
      try {
        if (await links.local?.(context, reference)) continue;
        await links.fetch(context, reference);
      } catch (error) {
        if (error instanceof OutsideScope) {
          if (!reference.uncertain) outside.push({ reference, sources: [...sources].sort() });
        }
        // A link to something deleted is the page's problem, not a failed sync.
        else if (!(error instanceof NotFound)) { ok = false; out.warn(`  ${entry.service.title}: couldn't fetch ${reference.id}. ${(error as Error).message}`); }
      }
    }
    buildServiceIndex(root, entry.service);
    fetched = Math.max(0, (await localFiles(root, name)) - before);
    if (fetched > 0) out.info(`${entry.service.title}: ${fetched} new from references.`);
    state[entry.key] = outside.map((item) => item.reference.id).sort();
    if (outside.length > 0) {
      out.info(`${entry.service.title}: ${outside.length} linked item${outside.length === 1 ? " is" : "s are"} outside the scope, so not fetched:`);
      for (const item of outside) {
        out.info(`  ${item.reference.url ?? item.reference.id}\n    linked from ${item.sources.join(", ")}\n    to fetch it: ${scopeCommand(entry.service, item.reference)}`);
      }
      out.info(`  Then run "dev sync ${entry.service.id}". Or set "fetch: anywhere" for ${entry.service.id} in dev.yaml to follow every link.`);
    }
  }
  writeOutside(root, state);
  return ok;
}

/**
 * Points the links in every mirrored file at the local copies, now that everything the
 * sync fetched is on disk. Also redoes links whose copy moved, and lists the ones outside
 * a scope in the files that link to them.
 */
async function localizeFiles(root: string, config: ProjectConfig, registry: Registry, out: Output): Promise<void> {
  const localize = createLocalizer({ root, config, registry, out, contextFor: (entry) => workspaceServiceContext(root, entry, config, registry, out) });
  for (const entry of enabledServices(config, registry)) {
    if (entry.service.role !== "connected") continue;
    for (const file of serviceFiles(root, entry.service)) {
      await localizeFile(path.join(root, file), localize);
    }
  }
}

async function localFiles(root: string, folder: string): Promise<number> {
  try {
    return (await readdir(path.join(root, folder), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && ["index.md", "design.md", "issue.md", "ticket.md", "item.md"].includes(entry.name)).length - (existsSync(path.join(root, folder, "index.md")) ? 1 : 0);
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
      for (const warning of report.warnings ?? []) out.warn(`  ${warning}`);
      if (report.failed.length > 0) ok = false;
      else {
        const { atomicWriteSync } = await import("../core/files.ts");
        atomicWriteSync(path.join(root, ".dev/state/sync-times", `${entry.service.id}.json`), JSON.stringify({ completed: new Date().toISOString() }));
      }
    } catch (error) {
      ok = false;
      const fix = (error as { fix?: string }).fix;
      out.warn(`${entry.service.title}: failed. ${(error as Error).message}${fix ? ` ${fix}` : ""}`);
    }
  }
  // Syncing a task source also fetches what its tasks point to, from every other service.
  const targets = entries.some((entry) => entry.service.tasks) ? enabledServices(config, registry) : entries;
  ok = (await sweep(root, config, registry, out, targets)) && ok;
  try {
    await localizeFiles(root, config, registry, out);
  } catch (error) {
    ok = false;
    out.warn(`Couldn't point links at the local copies. ${(error as Error).message}`);
  }
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
  const state = refreshState(root);
  if (state.running) throw new DevError(`A sync is already running: ${describeRefresh(state.refresh)}.`, 'Wait for it: "dev day status" says when it\'s done.');
  const clear = markRefresh(root, `dev sync${only ? ` ${only}` : ""}${options.referenced ? " --referenced" : ""}`, Boolean(options.recover));
  let ok: boolean;
  try {
    ok = await syncServices(root, config, registry, out, targets, options);
  } finally {
    clear();
  }
  out.info(ok ? "Done: synced. Review the changes before committing them." : "Done, with failures. Run it again to retry.");
  if (!ok) process.exitCode = 1;
}
