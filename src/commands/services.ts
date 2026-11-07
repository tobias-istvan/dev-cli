import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { parse } from "yaml";
import type { Registry } from "../plugins/registry.ts";
import type { Output, Scope, ServiceEntry } from "../plugins/types.ts";
import { workspaceServiceContext } from "../core/context.ts";
import { DevError, formatProblems } from "../core/output.ts";
import { loadConfig, saveConfig } from "../core/project-config.ts";
import { scaffold } from "../core/scaffold.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";
import { ensureLogin } from "./login.ts";
import { workspaceCommands } from "./shared.ts";

function connected(registry: Registry, name: string): ServiceEntry {
  const entry = registry.service(name);
  if (!entry || entry.service.role !== "connected") {
    const options = registry.services().filter((e) => e.service.role === "connected").map((e) => e.service.id);
    throw new DevError(`"${name}" isn't a service dev can add.`, `Use one of: ${options.join(", ")}.`);
  }
  return entry;
}

function parseScope(text: string): Scope {
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    throw new DevError("--scope isn't valid YAML or JSON.", `For example: --scope '{ jql: "assignee = currentUser()" }'`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DevError("--scope should be a set of keys.");
  return value as Scope;
}

/** A scope from --scope, or from the service's own questions. */
async function scopeFor(root: string, entry: ServiceEntry, registry: Registry, out: Output, given: string | undefined): Promise<Scope> {
  const config = loadConfig(root);
  const scope = given ? parseScope(given) : await entry.service.scope.choose(workspaceServiceContext(root, entry, config, registry, out));
  const problems = entry.service.scope.validate(scope);
  if (problems.length > 0) throw new DevError(`That scope doesn't work for ${entry.service.title}:\n${formatProblems(problems)}`);
  return scope;
}

function refreshFiles(program: Command, root: string, registry: Registry, out: Output): void {
  const config = loadConfig(root);
  const result = scaffold(root, config, registry, workspaceCommands(program, registry, config));
  const changed = result.created.length + result.updated.length + result.removed.length;
  if (changed > 0) out.info(`Updated ${changed} agent file${changed === 1 ? "" : "s"}.`);
  if (result.differs.length > 0) out.info(`Edited by hand, so not updated: ${result.differs.join(", ")}.`);
}

export async function runAdd(program: Command, registry: Registry, out: Output, name: string, options: { scope?: string }): Promise<void> {
  const root = requireWorkspaceRoot();
  const entry = connected(registry, name);
  const config = loadConfig(root);
  if (config.services.some((s) => s.service === entry.key)) {
    throw new DevError(`${entry.service.title} is already enabled.`, `Change what it syncs with "dev ${entry.service.id} scope".`);
  }

  await ensureLogin(entry.plugin, out);
  const scope = await scopeFor(root, entry, registry, out, options.scope);
  config.services.push({ service: entry.key, scope });
  saveConfig(root, config);
  refreshFiles(program, root, registry, out);
  out.info(`Done: added ${entry.service.title} (${entry.service.scope.describe(scope)}). Next: dev sync ${entry.service.id}`);
}

export async function runRemove(program: Command, registry: Registry, out: Output, name: string, options: { deleteFiles?: boolean }): Promise<void> {
  const root = requireWorkspaceRoot();
  const entry = connected(registry, name);
  const config = loadConfig(root);
  if (!config.services.some((s) => s.service === entry.key)) throw new DevError(`${entry.service.title} isn't enabled.`);

  config.services = config.services.filter((s) => s.service !== entry.key);
  saveConfig(root, config);
  refreshFiles(program, root, registry, out);

  const folder = path.join(root, entry.service.id);
  if (options.deleteFiles && existsSync(folder)) {
    rmSync(folder, { recursive: true, force: true });
    out.info(`Done: removed ${entry.service.title} and its folder ${entry.service.id}/.`);
  } else {
    out.info(`Done: removed ${entry.service.title}.${existsSync(folder) ? ` Its folder ${entry.service.id}/ is still there; delete it with --delete-files, or by hand.` : ""}`);
  }
}

export async function runScope(
  program: Command,
  registry: Registry,
  out: Output,
  entry: ServiceEntry,
  options: { set?: string; action?: string; items?: string[] },
): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const current = config.services.find((s) => s.service === entry.key);
  if (!current) throw new DevError(`${entry.service.title} isn't enabled in this workspace.`, `Add it with "dev add ${entry.service.id}".`);

  if (options.action) {
    const change = options.action === "add" ? entry.service.scope.add : options.action === "remove" ? entry.service.scope.remove : undefined;
    if (options.action !== "add" && options.action !== "remove") throw new DevError(`"${options.action}" isn't something scope can do.`, "Use add or remove.");
    if (!change) throw new DevError(`${entry.service.title}'s scope can't be changed item by item.`, `Run "dev ${entry.service.id} scope" to choose it, or use --set.`);
    if (!options.items || options.items.length === 0) throw new DevError(`Say what to ${options.action}, like a link or an id.`);

    const result = change(current.scope, options.items);
    for (const problem of result.problems) out.warn(problem.message);
    const changed = "added" in result ? result.added : result.removed;
    if (changed.length === 0) {
      out.info("Nothing changed.");
      if (result.problems.length > 0) process.exitCode = 1;
      return;
    }
    const problems = entry.service.scope.validate(result.scope);
    if (problems.length > 0) throw new DevError(`That would leave ${entry.service.title} with a scope that doesn't work:\n${formatProblems(problems)}`);
    current.scope = result.scope;
    saveConfig(root, config);
    out.info(`Done: ${options.action === "add" ? "added" : "removed"} ${changed.join(", ")}. ${entry.service.title} now syncs ${entry.service.scope.describe(current.scope)}. Next: dev sync ${entry.service.id}`);
    if (result.problems.length > 0) process.exitCode = 1;
    return;
  }

  if (!options.set && !(process.stdin.isTTY && process.stdout.isTTY)) {
    out.info(`${entry.service.title} syncs: ${entry.service.scope.describe(current.scope)}`);
    out.info("Change it with --set, or run this at a terminal to choose.");
    return;
  }
  current.scope = await scopeFor(root, entry, registry, out, options.set);
  saveConfig(root, config);
  refreshFiles(program, root, registry, out);
  out.info(`Done: ${entry.service.title} now syncs ${entry.service.scope.describe(current.scope)}. Next: dev sync ${entry.service.id}`);
}
