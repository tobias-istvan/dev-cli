import { atomicWriteSync, safePath } from "./files.ts";
import { existsSync, readFileSync } from "node:fs";
import { isNode, isSeq, parseDocument, stringify, YAMLSeq } from "yaml";
import type { Problem, Scope } from "../plugins/types.ts";
import { DevError } from "./output.ts";
import { CONFIG_FILE } from "./workspace.ts";

/**
 * dev.yaml: the project config, committed with the workspace and shared by the team. It
 * never holds credentials.
 *
 * This module checks the file's own shape. Whether each service exists and accepts its
 * scope is checked against the plugins, in doctor.
 */

export const CONFIG_VERSION = 1;

export interface ServiceConfig {
  /** "<plugin>:<service>", like "atlassian:jira". */
  service: string;
  scope: Scope;
  /** Absent means within-scope. */
  fetch?: "within-scope" | "anywhere";
  /** Absent means full. */
  sync?: "full" | "referenced";
}

export interface ProjectConfig {
  version: number;
  versioning?: { service: string; repo: string };
  services: ServiceConfig[];
  conventions: {
    /** Branch names for tasks, like "{type}/{id}-{slug}". */
    branch?: string;
    /** The branch tasks start from and merge into, like develop. Absent means the repository's default branch. */
    base?: string;
    /** Files only in the clone, like apps/web/.env.local, copied into each new worktree if git ignores them. */
    worktreeFiles?: string[];
    /** The repository's checks by name, like test: npm test. Absent means the skills find them in the repository. */
    checks?: Record<string, string>;
    /** Days after a task's PR merged that dev sync keeps adding its sources' changes to it. Absent means 30. */
    watchDays?: number;
  };
}

const SERVICE_KEY = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const TOP_LEVEL = new Set(["version", "versioning", "services", "conventions", "plugins"]);

/** A plausible branch name: what git accepts, short of asking git. */
export function isBranchName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value) && !/\.\.|\/\/|\/$|\.lock$|\/\.|\.$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses dev.yaml's text. Never throws: every problem is returned, with a fix. */
export function parseConfig(text: string): { config: ProjectConfig; problems: Problem[] } {
  const problems: Problem[] = [];
  const config: ProjectConfig = { version: CONFIG_VERSION, services: [], conventions: {} };

  const document = parseDocument(text);
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      problems.push({ message: `${CONFIG_FILE} isn't valid YAML: ${error.message.split("\n")[0]}` });
    }
    return { config, problems };
  }

  const data: unknown = document.toJS();
  if (!isObject(data)) {
    problems.push({ message: `${CONFIG_FILE} is empty or isn't a set of keys.`, fix: 'Run "dev init" to create it.' });
    return { config, problems };
  }

  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL.has(key)) problems.push({ message: `${CONFIG_FILE} has an unknown key "${key}".`, fix: "Remove it, or check its spelling." });
  }

  if (data.version !== CONFIG_VERSION) {
    problems.push({
      message: `${CONFIG_FILE} has version ${JSON.stringify(data.version)}, and this dev understands version ${CONFIG_VERSION}.`,
      fix: data.version === undefined ? `Add "version: ${CONFIG_VERSION}".` : "Update dev, or check the file.",
    });
  }

  if (data.versioning !== undefined) {
    const versioning = data.versioning;
    if (!isObject(versioning) || typeof versioning.service !== "string" || typeof versioning.repo !== "string") {
      problems.push({ message: '"versioning" needs a "service" and a "repo".', fix: 'For example: service: github:versioning and repo: owner/name.' });
    } else if (!SERVICE_KEY.test(versioning.service)) {
      problems.push({ message: `"versioning.service" should look like plugin:service, not "${versioning.service}".` });
    } else {
      config.versioning = { service: versioning.service, repo: versioning.repo };
    }
  }

  if (data.services !== undefined && !Array.isArray(data.services)) {
    problems.push({ message: '"services" should be a list.' });
  }

  const seen = new Set<string>();
  for (const [index, entry] of (Array.isArray(data.services) ? data.services : []).entries()) {
    const where = `services[${index}]`;
    if (!isObject(entry) || typeof entry.service !== "string") {
      problems.push({ message: `${where} needs a "service", like atlassian:jira.` });
      continue;
    }
    if (!SERVICE_KEY.test(entry.service)) {
      problems.push({ message: `${where}.service should look like plugin:service, not "${entry.service}".` });
      continue;
    }
    if (seen.has(entry.service)) {
      problems.push({ message: `${entry.service} is listed twice.`, fix: "Keep one entry and merge the scopes." });
      continue;
    }
    if (entry.scope !== undefined && !isObject(entry.scope)) {
      problems.push({ message: `${entry.service}'s scope should be a set of keys.` });
      continue;
    }
    if (entry.fetch !== undefined && entry.fetch !== "within-scope" && entry.fetch !== "anywhere") {
      problems.push({ message: `${entry.service}'s fetch should be within-scope or anywhere, not "${String(entry.fetch)}".` });
      continue;
    }
    if (entry.sync !== undefined && entry.sync !== "full" && entry.sync !== "referenced") {
      problems.push({ message: `${entry.service}'s sync should be full or referenced, not "${String(entry.sync)}".` });
      continue;
    }
    seen.add(entry.service);
    config.services.push({
      service: entry.service,
      scope: (entry.scope as Scope | undefined) ?? {},
      ...(entry.fetch ? { fetch: entry.fetch } : {}),
      ...(entry.sync ? { sync: entry.sync } : {}),
    });
  }

  if (data.conventions !== undefined) {
    if (!isObject(data.conventions)) {
      problems.push({ message: '"conventions" should be a set of keys.' });
    } else if (data.conventions.branch !== undefined) {
      if (typeof data.conventions.branch !== "string" || !data.conventions.branch.includes("{id}")) {
        problems.push({ message: '"conventions.branch" should be text containing {id}, like "{type}/{id}-{slug}".' });
      } else {
        config.conventions.branch = data.conventions.branch;
      }
    }
    const base = isObject(data.conventions) ? data.conventions.base : undefined;
    if (base !== undefined) {
      if (!isBranchName(base)) {
        problems.push({ message: '"conventions.base" should be a branch name, like develop or release/1.2.' });
      } else {
        config.conventions.base = base;
      }
    }
    const files = isObject(data.conventions) ? data.conventions.worktreeFiles : undefined;
    if (files !== undefined) {
      if (!Array.isArray(files) || !files.every((f) => typeof f === "string" && f && !f.startsWith("/") && !f.split("/").includes(".."))) {
        problems.push({ message: '"conventions.worktreeFiles" should be a list of paths inside the repository, like apps/web/.env.local.' });
      } else {
        config.conventions.worktreeFiles = files as string[];
      }
    }
    const checks = isObject(data.conventions) ? data.conventions.checks : undefined;
    if (checks !== undefined) {
      if (!isObject(checks) || Object.keys(checks).length === 0 || !Object.values(checks).every((c) => typeof c === "string" && c.trim())) {
        problems.push({ message: '"conventions.checks" should name each check and its command, like test: npm test.' });
      } else {
        config.conventions.checks = checks as Record<string, string>;
      }
    }
    const watchDays = isObject(data.conventions) ? data.conventions.watchDays : undefined;
    if (watchDays !== undefined) {
      if (!Number.isInteger(watchDays) || (watchDays as number) < 0) {
        problems.push({ message: '"conventions.watchDays" should be a number of days, like 30.' });
      } else {
        config.conventions.watchDays = watchDays as number;
      }
    }
  }

  return { config, problems };
}

export function configPath(root: string): string {
  return safePath(root, CONFIG_FILE);
}

/** Loads dev.yaml, failing with every problem listed when it isn't usable. */
export function loadConfig(root: string): ProjectConfig {
  const file = configPath(root);
  if (!existsSync(file)) {
    throw new DevError(`There's no ${CONFIG_FILE} in ${root}.`, 'Run "dev init".');
  }
  const { config, problems } = parseConfig(readFileSync(file, "utf8"));
  if (problems.length > 0) {
    throw new DevError(
      `${CONFIG_FILE} has problems:\n${problems.map((p) => `- ${p.message}${p.fix ? ` ${p.fix}` : ""}`).join("\n")}`,
      'Fix them, then run "dev doctor".',
    );
  }
  return config;
}

/**
 * Writes dev.yaml. An existing file keeps its comments: only the keys this config sets
 * are replaced.
 */
export function saveConfig(root: string, config: ProjectConfig): void {
  const file = configPath(root);
  const data: Record<string, unknown> = { version: config.version };
  if (config.versioning) data.versioning = config.versioning;
  data.services = config.services.map((s) => {
    const entry: Record<string, unknown> = { service: s.service };
    if (Object.keys(s.scope).length > 0) entry.scope = s.scope;
    if (s.fetch) entry.fetch = s.fetch;
    if (s.sync) entry.sync = s.sync;
    return entry;
  });
  if (Object.keys(config.conventions).length > 0) data.conventions = config.conventions;

  if (!existsSync(file)) {
    atomicWriteSync(file, stringify(data));
    return;
  }

  const document = parseDocument(readFileSync(file, "utf8"));
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  for (const [key, value] of Object.entries(data)) {
    const current = document.get(key, true);
    const currentValue: unknown = isNode(current) ? current.toJSON() : current;
    if (same(currentValue, value)) continue;

    if (key === "services" && isSeq(current) && Array.isArray(value)) {
      // Keep each unchanged entry's node, so its comments stay with it.
      const kept = new YAMLSeq();
      for (const entry of value) {
        const existing = current.items.find((item) => same(isNode(item) ? item.toJSON() : item, entry));
        kept.items.push(existing ?? document.createNode(entry));
      }
      kept.commentBefore = current.commentBefore;
      kept.comment = current.comment;
      document.set(key, kept);
      continue;
    }
    document.set(key, value);
  }
  for (const key of ["versioning", "conventions"]) {
    if (!(key in data)) document.delete(key);
  }
  atomicWriteSync(file, document.toString());
}
