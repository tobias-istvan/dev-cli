import { existsSync } from "node:fs";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import type { Output } from "../plugins/types.ts";
import { buildIndex } from "../core/indexes.ts";
import { DevError } from "../core/output.ts";
import { loadConfig } from "../core/project-config.ts";
import { enabledServices } from "../core/scaffold.ts";
import { requireWorkspaceRoot } from "../core/workspace.ts";

export function runIndex(registry: Registry, out: Output, only?: string): void {
  const root = requireWorkspaceRoot();
  const config = loadConfig(root);
  const indexed = enabledServices(config, registry).filter((entry) => entry.service.index || entry.service.role === "connected");
  const targets = only ? indexed.filter((entry) => entry.service.id === only || entry.key === only) : indexed;

  if (only && targets.length === 0) {
    throw new DevError(`"${only}" isn't an enabled service in this workspace.`, 'Run "dev doctor" to see what is.');
  }

  for (const { service } of targets) {
    const name = service.index?.folder ?? service.id;
    const folder = path.join(root, name);
    if (!existsSync(folder)) {
      out.info(`${name}/: no folder yet. Run a sync first.`);
      continue;
    }
    const result = buildIndex(folder, service.index?.title ?? service.title, service.index?.include);
    out.info(`${name}/index.md: ${result.items} item${result.items === 1 ? "" : "s"}.`);
    for (const skipped of result.skipped) {
      out.warn(`  Skipped ${name}/${skipped.file}: missing ${skipped.missing.join(", ")} in its front matter.`);
    }
  }
}
