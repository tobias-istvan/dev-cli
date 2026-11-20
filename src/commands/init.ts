import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { Registry } from "../plugins/registry.ts";
import type { Output, ServiceEntry } from "../plugins/types.ts";
import { pluginContext, serviceContext } from "../core/context.ts";
import { loadCredentials } from "../core/credentials.ts";
import { DevError } from "../core/output.ts";
import { count, stage, step } from "../core/progress.ts";
import { chooseMany, choose, search, withInkPrompts } from "../core/prompt.ts";
import { configPath, parseConfig, type ProjectConfig, saveConfig, CONFIG_VERSION } from "../core/project-config.ts";
import { scaffold } from "../core/scaffold.ts";
import { findWorkspaceRoot } from "../core/workspace.ts";
import { ensureLogin } from "./login.ts";
import { workspaceCommands } from "./shared.ts";

export interface InitOptions {
  versioning?: string;
  repo?: string;
  cloneUrl?: string;
  clone: boolean;
  service?: string[];
  account?: string;
}

function list(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function resolveService(registry: Registry, name: string, role: "versioning" | "connected"): ServiceEntry {
  const entry = registry.service(name);
  const choices = registry.services().filter((e) => e.service.role === role).map((e) => e.key);
  if (!entry || entry.service.role !== role) {
    throw new DevError(`"${name}" isn't a ${role === "versioning" ? "versioning" : "connected"} service.`, `Use one of: ${choices.join(", ") || "none available yet"}.`);
  }
  return entry;
}

async function pickVersioning(registry: Registry, config: ProjectConfig, flag: string | undefined, out: Output): Promise<ServiceEntry> {
  if (config.versioning) {
    const current = resolveService(registry, config.versioning.service, "versioning");
    if (flag && resolveService(registry, flag, "versioning").key !== current.key) {
      throw new DevError(`This workspace already uses ${current.key}.`, "Edit dev.yaml to change it, then run dev init again.");
    }
    out.info(`Versioning: ${current.service.title}, from dev.yaml.`);
    return current;
  }
  if (flag) return resolveService(registry, flag, "versioning");

  const options = registry.services().filter((e) => e.service.role === "versioning");
  if (options.length === 1 && options[0]) {
    out.info(`Versioning: ${options[0].service.title}, the only one available.`);
    return options[0];
  }
  const key = await choose("Where is the code hosted?", options.map((e) => ({ value: e.key, name: e.service.title })), "--versioning <service>");
  return resolveService(registry, key, "versioning");
}

async function pickRepository(entry: ServiceEntry, config: ProjectConfig, flag: string | undefined, out: Output): Promise<string> {
  if (config.versioning?.repo) {
    if (flag && flag !== config.versioning.repo) {
      throw new DevError(`This workspace is for ${config.versioning.repo}.`, "A workspace holds one repository. Create another workspace for this one.");
    }
    return config.versioning.repo;
  }
  if (flag) return flag;

  const saved = loadCredentials(entry.plugin.name);
  if (!saved || !entry.service.versioning) throw new DevError(`No ${entry.plugin.title} login to list repositories with.`);

  const versioning = entry.service.versioning;
  const repositories = await step(
    out,
    `Fetching your ${entry.plugin.title} repositories`,
    () => versioning.listRepositories(pluginContext(null, out), saved.credentials),
    (found) => `Found ${count(found.length, "repository", "repositories")} on ${entry.plugin.title}`,
  );
  if (repositories.length === 0) {
    throw new DevError(`Your ${entry.plugin.title} account can't see any repositories.`, "Pass --repo <owner/name>, or log in with another account.");
  }
  return search(
    "Which repository? Type to filter.",
    repositories.map((r) => ({ value: r.id, name: r.id, description: r.description })),
    "--repo <owner/name>",
  );
}

async function pickServices(registry: Registry, config: ProjectConfig, flags: string[], out: Output): Promise<ServiceEntry[]> {
  const enabled = new Set(config.services.map((s) => s.service));
  if (flags.length > 0) {
    return flags.map((name) => resolveService(registry, name, "connected")).filter((entry) => !enabled.has(entry.key));
  }

  const available = registry.services().filter((e) => e.service.role === "connected" && !enabled.has(e.key));
  if (available.length === 0) return [];
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    out.info("Connected services: none added. Add them later with --service, or dev add.");
    return [];
  }
  const keys = await chooseMany(
    "Which other services does the team use? Type to filter, Tab to pick, Enter when done, or straight away for none.",
    available.map((e) => ({ value: e.key, name: `${e.service.title}: ${e.service.description}` })),
    "--service <service>",
    true,
  );
  return keys.map((key) => resolveService(registry, key, "connected"));
}

type CloneResult = "cloned" | "already there" | "skipped" | "failed";

async function cloneRepository(root: string, entry: ServiceEntry, repo: string, url: string | undefined, out: Output): Promise<CloneResult> {
  const target = path.join(root, "repository");
  if (existsSync(path.join(target, ".git"))) return "already there";
  if (existsSync(target) && readdirSync(target).length > 0) {
    out.warn("repository/ has files in it but isn't a git clone, so it was left alone.");
    return "failed";
  }

  const saved = loadCredentials(entry.plugin.name);
  const versioning = entry.service.versioning;
  if (!versioning) return "failed";
  // A clone URL that's a local folder has to stop depending on where init ran from.
  const source = url && existsSync(url) ? path.resolve(url) : url;
  return (await versioning.clone(pluginContext(root, out), saved?.credentials ?? {}, repo, target, source)) ? "cloned" : "failed";
}

/** Init asks its questions, its logins' and its services' with ink. */
export function runInit(program: Command, registry: Registry, out: Output, folder: string | undefined, options: InitOptions): Promise<void> {
  return withInkPrompts(() => initWorkspace(program, registry, out, folder, options));
}

async function initWorkspace(program: Command, registry: Registry, out: Output, folder: string | undefined, options: InitOptions): Promise<void> {
  const root = path.resolve(folder ?? process.cwd());
  const goThere = folder ? `cd ${folder} && ` : "";

  const existing = findWorkspaceRoot(root);
  if (existing && existing !== root) {
    throw new DevError(`${root} is inside the workspace at ${existing}.`, "A workspace can't hold another. Choose a folder outside it.");
  }
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new DevError(`${root} is a file, not a folder.`, "Choose another name.");
  }
  mkdirSync(root, { recursive: true });

  if (spawnSync("git", ["--version"]).error) {
    throw new DevError("git isn't installed.", "Install it, then run dev init again.");
  }
  if (!existsSync(path.join(root, ".git"))) spawnSync("git", ["init", "--quiet"], { cwd: root });

  let config: ProjectConfig = { version: CONFIG_VERSION, services: [], conventions: {} };
  if (existsSync(configPath(root))) {
    const parsed = parseConfig(readFileSync(configPath(root), "utf8"));
    if (parsed.problems.length > 0) {
      throw new DevError("dev.yaml has problems, so init stopped before changing anything.", 'Run "dev doctor" to see them.');
    }
    config = parsed.config;
  }

  const stages = options.clone ? 4 : 3;

  // 1-2. The versioning service and its repository.
  stage(out, 1, stages, "The code");
  const versioning = await pickVersioning(registry, config, options.versioning, out);
  await ensureLogin(versioning.plugin, out, { account: options.account });
  const repo = await pickRepository(versioning, config, options.repo, out);
  config.versioning = { service: versioning.key, repo };

  // 3-5. Connected services, their logins and scopes.
  stage(out, 2, stages, "Connected services");
  for (const entry of await pickServices(registry, config, list(options.service), out)) {
    await ensureLogin(entry.plugin, out);
    let scope = {};
    if (process.stdin.isTTY && process.stdout.isTTY) {
      out.info(`Choose what ${entry.service.title} should sync.`);
      scope = await entry.service.scope.choose(serviceContext(root, entry, {}, out));
    } else {
      out.info(`${entry.service.title}: no scope chosen. Run "dev ${entry.service.id} scope" to choose one.`);
    }
    config.services.push({ service: entry.key, scope });
  }

  // 6. The config and generated files.
  stage(out, 3, stages, "Workspace files");
  saveConfig(root, config);
  const files = scaffold(root, config, registry, workspaceCommands(program, registry, config));
  out.info(`\nWorkspace files: ${files.created.length} created, ${files.updated.length} updated, ${files.unchanged.length} already in place.`);
  if (files.differs.length > 0) {
    out.info(`Edited by hand, so left as they are:\n${files.differs.map((f) => `  ${f}`).join("\n")}`);
  }

  // 7. The code.
  let clone: CloneResult = "skipped";
  if (options.clone) {
    stage(out, 4, stages, "Cloning the code");
    clone = await cloneRepository(root, versioning, repo, options.cloneUrl, out);
    if (clone === "failed") {
      const url = options.cloneUrl ?? versioning.service.versioning?.cloneUrl(repo) ?? repo;
      out.warn(`The clone failed. Once that's fixed, retry with: ${goThere}git clone ${url} repository`);
      process.exitCode = 1;
    } else {
      out.info(clone === "cloned" ? "Code: cloned into repository/." : "Code: already cloned in repository/.");
    }
  }

  out.info(`\nDone: ${repo} is set up in ${root}.`);
  out.info(`Next: ${goThere}dev doctor`);
  out.info("Nothing was committed.");
}
