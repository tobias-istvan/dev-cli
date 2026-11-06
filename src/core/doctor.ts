import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Output, Plugin, Problem } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { pluginContext, serviceContext } from "./context.ts";
import { loadCredentials, looseWarning } from "./credentials.ts";
import { configPath, parseConfig } from "./project-config.ts";
import { type CommandRow, generatedFiles } from "./scaffold.ts";
import { CONFIG_FILE } from "./workspace.ts";

/**
 * Checks a workspace and says how to fix each problem. It changes nothing. Without
 * --offline it also checks each login with its service.
 */

export interface DoctorOptions {
  offline: boolean;
  commands: CommandRow[];
}

export interface DoctorReport {
  problems: Problem[];
  notes: string[];
}

export async function doctor(root: string, registry: Registry, out: Output, options: DoctorOptions): Promise<DoctorReport> {
  const problems: Problem[] = [...registry.problems()];
  const notes: string[] = [];

  const { config, problems: configProblems } = parseConfig(readFileSync(configPath(root), "utf8"));
  problems.push(...configProblems);

  const plugins = new Map<string, Plugin>();

  if (!config.versioning) {
    problems.push({ message: `${CONFIG_FILE} names no versioning service.`, fix: 'Run "dev init" to choose one.' });
  } else {
    const entry = registry.service(config.versioning.service);
    if (!entry) {
      problems.push({ message: `Unknown versioning service "${config.versioning.service}".`, fix: "Check the name, or update dev." });
    } else if (entry.service.role !== "versioning") {
      problems.push({ message: `${entry.key} isn't a versioning service.`, fix: "Move it to the services list." });
    } else {
      plugins.set(entry.plugin.name, entry.plugin);
    }
  }

  for (const { service: key, scope } of config.services) {
    const entry = registry.service(key);
    if (!entry || entry.key !== key) {
      problems.push({ message: `Unknown service "${key}".`, fix: "Check the name, or update dev." });
      continue;
    }
    if (entry.service.role !== "connected") {
      problems.push({ message: `${key} is a versioning service, so it belongs under "versioning".` });
      continue;
    }
    plugins.set(entry.plugin.name, entry.plugin);

    for (const problem of entry.service.scope.validate(scope)) {
      problems.push({ message: `${key} scope: ${problem.message}`, fix: problem.fix ?? `Run "dev ${entry.service.id} scope".` });
    }

    if (entry.service.doctor) {
      try {
        problems.push(...(await entry.service.doctor(serviceContext(root, entry, scope, out))));
      } catch (error) {
        problems.push({ message: `${key}'s own checks failed: ${(error as Error).message}` });
      }
    }
  }

  for (const plugin of plugins.values()) {
    const warning = looseWarning(plugin.name);
    if (warning) problems.push({ message: warning });

    const saved = loadCredentials(plugin.name);
    if (!saved) {
      problems.push({ message: `You're not logged in to ${plugin.title}.`, fix: `Run "dev login ${plugin.name}" yourself.` });
      continue;
    }
    if (options.offline) continue;

    try {
      const status = await plugin.login.check(pluginContext(root, out), saved.credentials);
      if (status.ok) {
        notes.push(`${plugin.title}: logged in${status.account ? ` as ${status.account}` : ""}.`);
      } else {
        problems.push(status.problem ?? { message: `${plugin.title} rejected the saved login.`, fix: `Run "dev login ${plugin.name}" again.` });
      }
    } catch (error) {
      problems.push({ message: `Couldn't check the ${plugin.title} login: ${(error as Error).message}`, fix: "Check your connection, or use --offline." });
    }
  }

  // Generated files: out of date ones are a problem, hand-edited ones only a note.
  let record: Record<string, string> = {};
  try {
    record = JSON.parse(readFileSync(path.join(root, ".dev", "generated.json"), "utf8")) as Record<string, string>;
  } catch {
    // Never generated.
  }
  const stale: string[] = [];
  for (const [relative, content] of generatedFiles(config, registry, options.commands)) {
    const file = path.join(root, relative);
    if (!existsSync(file)) {
      stale.push(relative);
      continue;
    }
    const current = createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
    if (current === createHash("sha256").update(content).digest("hex")) continue;
    if (record[relative] === current) stale.push(relative);
    else notes.push(`${relative} was edited by hand, so dev leaves it alone.`);
  }
  if (stale.length > 0) {
    problems.push({ message: `Generated files are missing or out of date: ${stale.join(", ")}.`, fix: 'Run "dev files".' });
  }

  return { problems, notes };
}
