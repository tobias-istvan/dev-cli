import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Output, Plugin, Problem } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { pluginContext, serviceContext } from "./context.ts";
import { step } from "./progress.ts";
import { loadCredentials, looseWarning } from "./credentials.ts";
import { configPath, parseConfig } from "./project-config.ts";
import { INSTRUCTIONS_FILE, instructionsState } from "./instructions.ts";
import { type CommandRow, generatedFiles } from "./scaffold.ts";
import { readRecord, recordIds } from "./task-record.ts";
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
  /** Malformed task record entries: worth fixing, never a failure. */
  warnings: string[];
}

/** What doctor says about a generated file someone edited by hand. */
function editedNote(relative: string): string {
  const note = `${relative} was edited by hand, so dev leaves it alone.`;
  if (relative !== "AGENTS.md" && relative !== "CLAUDE.md") return note;
  return `${note} To get dev's updates again, move your additions to ${INSTRUCTIONS_FILE}, delete ${relative} and run "dev files".`;
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
        const doctor = entry.service.doctor;
        problems.push(...(await step(out, `Checking ${entry.service.title}`, (progress) => doctor({ ...serviceContext(root, entry, scope, out), progress }))));
      } catch (error) {
        problems.push({ message: `${key}'s own checks failed: ${(error as Error).message}` });
      }
    }
  }

  for (const plugin of plugins.values()) {
    const warning = looseWarning(plugin.name);
    if (warning) problems.push({ message: warning });

    let saved;
    try { saved = loadCredentials(plugin.name); } catch (error) { problems.push({ message: (error as Error).message, fix: (error as Error & { fix?: string }).fix }); continue; }
    if (!saved) {
      if (plugin.login.optional) notes.push(`${plugin.title}: no login, which is fine. With one, ${plugin.login.optional.benefit}.`);
      else problems.push({ message: `You're not logged in to ${plugin.title}.`, fix: `Run "dev login ${plugin.name}" yourself.` });
      continue;
    }
    if (options.offline) continue;

    try {
      const credentials = saved.credentials;
      const status = await step(out, `Checking the ${plugin.title} login`, () => plugin.login.check(pluginContext(root, out), credentials));
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
    if (record[relative] === current) {
      stale.push(relative);
      continue;
    }
    notes.push(editedNote(relative));
  }

  // The workspace's own instructions: never a problem, only worth a mention.
  const instructions = instructionsState(root);
  if (instructions === "empty" || instructions === "stub") {
    notes.push(`${INSTRUCTIONS_FILE} has no instructions in it yet. Add your own there: agents read it after AGENTS.md.`);
  }
  if (stale.length > 0) {
    problems.push({ message: `Generated files are missing or out of date: ${stale.join(", ")}.`, fix: 'Run "dev files".' });
  }

  // Task records: agents write them by hand, so what's malformed is a warning.
  const warnings: string[] = [];
  for (const id of await recordIds(root)) {
    for (const w of (await readRecord(root, id)).warnings) warnings.push(`${w.file}${w.line ? `:${w.line}` : ""}  ${w.message}`);
  }

  return { problems, notes, warnings };
}
