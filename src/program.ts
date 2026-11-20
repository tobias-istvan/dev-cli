import { withRefresh } from "./core/refresh.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { Registry } from "./plugins/registry.ts";
import type { Output, ServiceEntry } from "./plugins/types.ts";
import { workspaceServiceContext } from "./core/context.ts";
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

interface InitOptionsFlags {
  versioning?: string;
  repo?: string;
  cloneUrl?: string;
  clone?: boolean;
  service?: string[];
  account?: string;
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

function addServiceCommands(program: Command, entry: ServiceEntry, registry: Registry, out: Output): void {
  const commands = entry.service.commands ?? [];
  if (commands.length === 0 && entry.service.role !== "connected") return;

  const group = program.command(entry.service.id).description(`${entry.service.title}: ${entry.service.description}`);

  if (entry.service.role === "connected") {
    const listable = Boolean(entry.service.scope.add);
    group
      .command("scope")
      .description(`Show or change what ${entry.service.title} syncs`)
      .argument("[action]", listable ? "add or remove, to change it by link or id" : "Leave out to show or choose it")
      .argument("[items...]", "Links or ids, for add and remove")
      .option("--set <scope>", "The new scope as YAML or JSON, instead of choosing")
      .option("--choose", "Choose a new scope interactively")
      .addHelpText(
        "after",
        details(`
Without arguments, shows the scope. Use --choose to change it interactively.${
          listable
            ? `

  dev ${entry.service.id} scope add <link or id>...      add items, like a page a ticket links to
  dev ${entry.service.id} scope remove <link or id>...   take them out again`
            : ""
        }

Changing the scope is the person's call: the command check asks before an agent does it.`),
      )
      .action(async (action: string | undefined, items: string[], options: { set?: string; choose?: boolean }) => {
        const { runScope } = await import("./commands/services.ts");
        await runScope(program, registry, out, entry, { ...options, action, items });
      });
  }

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
      const run = () => definition.run(workspaceServiceContext(root, entry, config, registry, out), self.args, self.opts());
      const writes = typeof definition.writes === "function" ? definition.writes(self.opts()) : Boolean(definition.writes);
      await (writes ? withRefresh(root, `dev ${entry.service.id} ${definition.name}`, run) : run());
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
    .command("init")
    .description("Set up a workspace for one repository, in this folder or the one you name")
    .argument("[folder]", "Where to set it up, created if needed (default: this folder)")
    .option("--versioning <service>", "Where the code is hosted, like github")
    .option("--repo <name>", "The repository, like owner/name")
    .option("--clone-url <url>", "Clone from this URL instead, like an SSH address")
    .option("--no-clone", "Don't clone the repository")
    .option("--service <services...>", "Connected services to add, like jira confluence")
    .option("--account <name>", "Which gh account to use, when logging in through gh")
    .addHelpText(
      "after",
      details(`
Asks where the code is hosted, logs you in, lets you pick the repository and the other
services the team uses, then writes dev.yaml and the workspace's files and clones the
code into repository/.

Every question has a flag, for scripts. It's safe to run again: it keeps what dev.yaml
already says, offers what's missing, and never overwrites a file you've edited. It never
commits or pushes.

Examples:
  dev init
  dev init ~/projects/web
  dev init --versioning github --repo acme/web --clone-url git@github.com:acme/web.git`),
    )
    .action(async (folder: string | undefined, options: InitOptionsFlags) => {
      const { runInit } = await import("./commands/init.ts");
      await runInit(program, registry, out, folder, { ...options, clone: options.clone !== false });
    });

  program
    .command("login")
    .description("Log in to a plugin's services (people only, not agents)")
    .argument("<plugin>", "Like github")
    .option("--method <method>", "How to log in, like cli or token")
    .option("--account <name>", "Which account, when logging in through another tool like gh")
    .addHelpText(
      "after",
      details(`
Saves the login on this machine only, outside every workspace, readable only by you.
With the cli method, dev borrows another tool's login, like gh's, and stores nothing
secret.

This needs a person at a terminal, so it refuses to run for agents and scripts.`),
    )
    .action(async (name: string, options: { method?: string; account?: string }) => {
      const { runLogin } = await import("./commands/login.ts");
      await runLogin(registry, out, name, options);
    });

  program
    .command("logout")
    .description("Remove a plugin's saved login")
    .argument("<plugin>", "Like github")
    .option("--account <name>", "Only this account")
    .action(async (name: string, options: { account?: string }) => {
      const { runLogout } = await import("./commands/login.ts");
      await runLogout(registry, out, name, options);
    });

  program
    .command("add")
    .description("Enable another service in this workspace")
    .argument("<service>", "Like jira or confluence")
    .option("--scope <scope>", "What it syncs, as YAML or JSON, instead of choosing")
    .addHelpText("after", details("Logs you in if needed, asks what to sync, then updates dev.yaml and the agent files."))
    .action(async (name: string, options: { scope?: string }) => {
      const { runAdd } = await import("./commands/services.ts");
      await runAdd(program, registry, out, name, options);
    });

  program
    .command("remove")
    .description("Disable a service in this workspace")
    .argument("<service>", "Like jira or confluence")
    .option("--delete-files", "Also delete its synced folder")
    .action(async (name: string, options: { deleteFiles?: boolean }) => {
      const { runRemove } = await import("./commands/services.ts");
      await runRemove(program, registry, out, name, options);
    });

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

  const task = program.command("task").description("Work on a task in its own worktree");

  task
    .command("start")
    .description("Set up a task: its worktree, brief and progress note")
    .argument("<ref>", "A ticket key, issue number, URL, or a short name for the task")
    .option("--title <text>", "The task's title, when the reference doesn't give one")
    .option("--type <word>", "The branch type, like feature or fix (default: from the item, or feature)")
    .option("--base <branch>", "Branch to start from and merge into (default: conventions.base, else the repository's default branch)")
    .addHelpText(
      "after",
      details(`
When an enabled service recognises the reference, its item and what it links to are
fetched, and the brief links to them. Otherwise the reference is the task's name.

Creates worktrees/<id> on a new branch from the latest base, and tasks/<id>/brief.md and
progress.md. The brief records the base, which status and cleanup compare with. Safe to re-run: an existing worktree or note is left as it is. It never
pushes.`),
    )
    .action(async (ref: string, options: { title?: string; type?: string; base?: string }) => {
      const { runTaskStart } = await import("./commands/task.ts");
      await withRefresh(requireWorkspaceRoot(), "dev task start", () => runTaskStart(registry, out, ref, options));
    });

  task
    .command("list")
    .description("List the tasks: open ones in scope, and any open ones assigned to you")
    .option("--mine", "Only tasks assigned to you")
    .option("--all", "Every task, including done ones and ones fetched only as context")
    .option("--refresh", "Sync the task sources first")
    .option("--json", "Machine-readable output")
    .addHelpText(
      "after",
      details(`
Reads the files the last sync wrote, so it's quick and works offline; the output says when
that was. Use this to answer "what are my tickets?" or "what should I work on?", rather
than reading the index.

Tasks marked parent, linked or pulled were fetched because something points to them: they
are context, not your work, unless they're also marked mine.`),
    )
    .action(async (options: { mine?: boolean; all?: boolean; refresh?: boolean; json?: boolean }) => {
      const { runTaskList } = await import("./commands/task.ts");
      await runTaskList(registry, out, options);
    });

  task
    .command("status")
    .description("Show the tasks in flight, or one task's state")
    .argument("[id]", "A task, for its commits and changes")
    .action(async (id: string | undefined) => {
      const { runTaskStatus } = await import("./commands/task.ts");
      await runTaskStatus(out, id);
    });

  task
    .command("cleanup")
    .description("Show which worktrees can go, and remove them on request")
    .option("--remove", "Remove the worktrees that are safe to remove")
    .addHelpText(
      "after",
      details(`
Safe means nothing is lost: no uncommitted changes, and every commit already in the task's
base branch, or a pull or merge request merged at the worktree's last commit, which covers
squash and rebase merges. Task notes in tasks/ are never removed.`),
    )
    .action(async (options: { remove?: boolean }) => {
      const { runTaskCleanup } = await import("./commands/task.ts");
      await runTaskCleanup(registry, out, options);
    });

  program
    .command("sync")
    .description("Sync every enabled service, or one")
    .argument("[service]", "Only this service, like jira")
    .option("--referenced", "For docs services, only update what's here and fetch what tasks point to")
    .option("--recover", "Release an unreadable lock left by an interrupted sync")
    .addHelpText(
      "after",
      details(`
Task sources, like Jira, always sync their whole scope. With --referenced, other services
only update the items already in the workspace, and fetch new ones that open tasks or PRs
point to. Set "sync: referenced" on a service in dev.yaml to make that its default.

Every sync ends by fetching what open tasks and PRs point to. Each service only fetches
within its scope, unless dev.yaml sets "fetch: anywhere" for it.

One service failing never stops the others. Review the changes before committing them.`),
    )
    .action(async (service: string | undefined, options: { referenced?: boolean; recover?: boolean }) => {
      const { runSync } = await import("./commands/sync.ts");
      await runSync(registry, out, service, { referenced: Boolean(options.referenced), recover: Boolean(options.recover) });
    });

  const day = program.command("day").description("Start and end the working day");

  day
    .command("start")
    .description("Update the code and every service, then write snapshot.md")
    .option("--no-sync", "Only rewrite snapshot.md from what's on disk")
    .option("--referenced", "Sync docs services as dev sync --referenced does")
    .addHelpText(
      "after",
      details(`
Fetches the code and fast-forwards the base branch when that's safe, syncs every enabled
service, then writes snapshot.md: the last session's next steps, the tasks in flight, and
what each service has to say. A step that fails doesn't stop the others.`),
    )
    .action(async (options: { sync?: boolean; referenced?: boolean }) => {
      const { runDayStart } = await import("./commands/day.ts");
      await runDayStart(registry, out, { sync: options.sync !== false, referenced: Boolean(options.referenced) });
    });

  day
    .command("status")
    .description("Say whether a sync is running, and when snapshot.md was written")
    .action(async () => {
      const { runDayStatus } = await import("./commands/day.ts");
      runDayStatus(out);
    });

  day
    .command("end")
    .description("Save the day's sessions and update the day summary")
    .option("--date <date>", "Summarise another day (YYYY-MM-DD)")
    .addHelpText(
      "after",
      details(`
Saves the transcripts of sessions not saved yet, including ones that were killed, then
rebuilds work-sessions/<date>/summary.md. Its facts are rebuilt each run; the sections
you write (What happened, Decisions, Next steps, Blocked) are kept.`),
    )
    .action(async (options: { date?: string }) => {
      const { runDayEnd } = await import("./commands/day.ts");
      await runDayEnd(registry, out, options);
    });

  program
    .command("check")
    .description("Show whether an agent may run a command, without running it")
    .argument("<command...>", 'The command, like "gh pr merge 12". Quote it if it has |, ; or &')
    .allowUnknownOption()
    .addHelpText(
      "after",
      details(`
Hooks run this check before each shell command and file edit an agent makes, in Copilot
CLI and Claude Code. Commands that only read run; commands that change a service ask the
person first; anything the check can't follow asks too. Commands it doesn't know are left
to your tool.

Changing the workspace's config is a separate kind, "config": dev add, remove, login and
logout, changing a scope, and any edit to dev.yaml or to your dev settings folder. It asks
by default; set "config": "deny" to block agents from it entirely.

Change the defaults in policy.json, in your dev config folder:

  {
    "read": "allow",
    "change": "ask",
    "config": "ask",
    "unknown": "ask",
    "commands": { "gh pr create": "allow", "gh pr merge": "deny" }
  }

Each value is allow, ask or deny, and the longest matching command wins. "gh auth token"
is denied unless you change it. Help is always a read.

This is a guardrail, not a security boundary: an agent runs as you.`),
    )
    .action(async (words: string[]) => {
      const { runCheck } = await import("./commands/hook.ts");
      runCheck(registry, out, words);
    });

  const hook = program.command("hook").description("Run by tool hooks, not by hand");
  for (const [name, description, run] of [
    ["session-start", "Add the workspace's context to a new session", "runSessionStart"],
    ["session-end", "Save the session when it ends", "runSessionEnd"],
    ["pre-tool", "Check an agent's command before it runs", "runPreTool"],
  ] as const) {
    hook
      .command(name)
      .description(description)
      .option("--tool <tool>", "The tool running the hook: claude or copilot", "claude")
      .action(async (options: { tool: string }) => {
        const module = await import("./commands/hook.ts");
        try {
          await module[run](registry, options.tool);
        } catch {
          // A hook must never fail a session.
          if (name !== "session-end") console.log("{}");
        }
      });
  }

  for (const entry of registry.services()) addServiceCommands(program, entry, registry, out);

  return program;
}
