import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { Registry } from "./plugins/registry.ts";
import type { Output, ServiceEntry } from "./plugins/types.ts";
import { serviceContext } from "./core/context.ts";
import { DevError } from "./core/output.ts";
import { packageDir } from "./core/paths.ts";
import { loadConfig } from "./core/project-config.ts";
import type { CommandRow } from "./core/scaffold.ts";
import { requireWorkspaceRoot } from "./core/workspace.ts";

/**
 * Builds the command tree: the core commands, then each service's own commands as
 * `dev <service> <action>`. Help text, AGENTS.md and the skills' command tables all come
 * from this one tree, so they can't drift apart.
 */

export interface ProgramOptions {
  registry: Registry;
  out: Output;
}

function version(): string {
  const file = path.join(packageDir(), "package.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

function details(text: string): string {
  return `\n${text.trim()}\n`;
}

/** Commands that aren't for people or agents to run by hand, so they stay out of tables. */
const INTERNAL = new Set(["hook"]);

function usage(command: Command, words: string[]): string {
  const args = command.registeredArguments.map((arg) => {
    const name = `${arg.name()}${arg.variadic ? "..." : ""}`;
    return arg.required ? `<${name}>` : `[${name}]`;
  });
  return ["dev", ...words, ...args].join(" ");
}

/**
 * One row per runnable command, for AGENTS.md and the skills. Service commands appear
 * only for the services in `enabled`, by id.
 */
export function commandRows(program: Command, enabled: Set<string>, services: Set<string>): CommandRow[] {
  const rows: CommandRow[] = [];

  const walk = (command: Command, words: string[]): void => {
    for (const child of command.commands) {
      const name = child.name();
      if (words.length === 0 && (INTERNAL.has(name) || (services.has(name) && !enabled.has(name)))) continue;
      const next = [...words, name];
      if (child.commands.length > 0) walk(child, next);
      else rows.push({ command: usage(child, next), does: child.description() });
    }
  };

  walk(program, []);
  return rows;
}

function addServiceCommands(program: Command, entry: ServiceEntry, out: Output): void {
  const commands = entry.service.commands ?? [];
  if (commands.length === 0) return;

  const group = program.command(entry.service.id).description(`${entry.service.title}: ${entry.service.description}`);

  for (const definition of commands) {
    const command = group
      .command(definition.name)
      .description(definition.description)
      .addHelpText(
        "after",
        details(
          `${definition.help ?? ""}\n\n${
            definition.mark === "change"
              ? `This changes things in ${entry.service.title}. Agents run it only when the person asks.`
              : `This only reads from ${entry.service.title}.`
          }`,
        ),
      );
    for (const argument of definition.arguments ?? []) command.argument(argument);
    for (const option of definition.options ?? []) command.option(option.flags, option.description, option.default);

    command.action(async (...actionArgs: unknown[]) => {
      const self = actionArgs.at(-1) as Command;
      const root = requireWorkspaceRoot();
      const config = loadConfig(root);
      const enabled = [config.versioning?.service, ...config.services.map((s) => s.service)];
      if (!enabled.includes(entry.key)) {
        throw new DevError(`${entry.service.title} isn't enabled in this workspace.`, `Add it with "dev add ${entry.service.id}".`);
      }
      const scope = config.services.find((s) => s.service === entry.key)?.scope ?? {};
      await definition.run(serviceContext(root, entry, scope, out), self.args, self.opts());
    });
  }
}

export function buildProgram({ registry, out }: ProgramOptions): Command {
  const program = new Command("dev")
    .description("Sets up a workspace around a code repository, and gathers the tickets, docs and\ndesigns each task needs, for people and AI agents.")
    .version(version(), "-v, --version", "Show the version")
    .helpOption("-h, --help", "Show this help")
    .helpCommand(false)
    .showHelpAfterError("(add --help to see the options)")
    .addHelpText("after", details("Run any command with --help to see what it does. Asking for help never changes anything."));

  program
    .command("doctor")
    .description("Check the workspace and say how to fix each problem")
    .option("--offline", "Don't check logins with their services")
    .addHelpText(
      "after",
      details(`
Checks dev.yaml, each service's scope, your logins and the generated files. It changes
nothing.

Exit codes:
  0  No problems
  1  At least one problem`),
    )
    .action(async (options: { offline?: boolean }) => {
      const { runDoctor } = await import("./commands/doctor.ts");
      await runDoctor(program, registry, out, Boolean(options.offline));
    });

  program
    .command("files")
    .description("Update the generated agent files from dev.yaml")
    .addHelpText(
      "after",
      details(`
Writes AGENTS.md, CLAUDE.md, the skills, service docs, MCP entries and dev's lines in
.gitignore, from dev.yaml and the enabled services.

A file you've edited by hand is left as it is and listed, so this is always safe to run.`),
    )
    .action(async () => {
      const { runFiles } = await import("./commands/files.ts");
      runFiles(program, registry, out);
    });

  program
    .command("index")
    .description("Rebuild each service folder's index.md from what's on disk")
    .argument("[service]", "Only this service, like jira")
    .action(async (service: string | undefined) => {
      const { runIndex } = await import("./commands/index.ts");
      runIndex(registry, out, service);
    });

  for (const entry of registry.services()) addServiceCommands(program, entry, out);

  return program;
}
