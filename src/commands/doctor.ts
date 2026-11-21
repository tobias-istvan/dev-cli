import type { Command } from "commander";
import type { Registry } from "../plugins/registry.ts";
import type { Output } from "../plugins/types.ts";
import { doctor } from "../core/doctor.ts";
import { formatProblems } from "../core/output.ts";
import { configPath, parseConfig } from "../core/project-config.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";
import { readFileSync } from "node:fs";
import { workspaceCommands } from "./shared.ts";

export async function runDoctor(program: Command, registry: Registry, out: Output, offline: boolean): Promise<void> {
  const root = requireWorkspaceRoot();
  const { config } = parseConfig(readFileSync(configPath(root), "utf8"));
  const report = await doctor(root, registry, out, { offline, commands: workspaceCommands(program, registry, config) });

  for (const note of report.notes) out.info(note);
  if (report.warnings.length > 0) {
    out.warn(`${report.warnings.length} task record warning${report.warnings.length === 1 ? "" : "s"}, from entries that don't follow the format:\n${report.warnings.map((w) => `  ${w}`).join("\n")}`);
  }
  if (report.problems.length === 0) {
    out.info("No problems found.");
    return;
  }

  out.info(`${report.problems.length} problem${report.problems.length === 1 ? "" : "s"}:\n${formatProblems(report.problems)}`);
  process.exitCode = 1;
}
