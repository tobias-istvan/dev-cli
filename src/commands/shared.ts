import type { Command } from "commander";
import type { Registry } from "../plugins/registry.ts";
import type { ProjectConfig } from "../core/project-config.ts";
import type { CommandRow } from "../core/scaffold.ts";
import { enabledServices } from "../core/scaffold.ts";
import { commandRows } from "../program.ts";

/** The command table for this workspace: core commands plus its enabled services'. */
export function workspaceCommands(program: Command, registry: Registry, config: ProjectConfig): CommandRow[] {
  const enabled = new Set(enabledServices(config, registry).map((entry) => entry.service.id));
  const all = new Set(registry.services().map((entry) => entry.service.id));
  return commandRows(program, enabled, all);
}
