import type { Command } from "commander";
import type { Registry } from "../plugins/registry.ts";
import type { Output } from "../plugins/types.ts";
import { loadConfig } from "../core/project-config.ts";
import { scaffold } from "../core/scaffold.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";
import { addAgentFiles, worktreeDir, worktreeIds } from "../core/worktree.ts";
import { workspaceCommands } from "./shared.ts";

export async function runFiles(program: Command, registry: Registry, out: Output): Promise<void> {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const result = scaffold(root, config, registry, workspaceCommands(program, registry, config));

  const report: Array<[string, string[]]> = [
    ["Created", result.created],
    ["Updated", result.updated],
    ["Removed", result.removed],
    ["Edited by hand, so left as they are", result.differs],
  ];
  for (const [label, files] of report) {
    if (files.length > 0) out.info(`${label}:\n${files.map((f) => `  ${f}`).join("\n")}`);
  }
  // Worktrees carry copies of the skills, hooks and MCP config: bring dev's copies up to date.
  const refreshed: string[] = [];
  for (const id of await worktreeIds(root)) {
    try {
      if ((await addAgentFiles(root, worktreeDir(root, id), { refresh: true })).length > 0) refreshed.push(id);
    } catch (error) {
      out.warn(`Couldn't update the agent files in worktrees/${id}: ${(error as Error).message}`);
    }
  }
  if (refreshed.length > 0) out.info(`Updated the agent files in ${refreshed.map((id) => `worktrees/${id}`).join(", ")}.`);

  const changed = result.created.length + result.updated.length + result.removed.length;
  out.info(changed === 0 ? "Done: everything was already up to date." : `Done: ${changed} file${changed === 1 ? "" : "s"} changed.`);
}
