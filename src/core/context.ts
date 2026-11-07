import path from "node:path";
import type { Output, PluginContext, Scope, ServiceContext, ServiceEntry } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { loadCredentials } from "./credentials.ts";
import { resolveReferences } from "./links.ts";
import { DevError } from "./output.ts";
import type { ProjectConfig } from "./project-config.ts";

export function pluginContext(root: string | null, out: Output): PluginContext {
  return { root, out, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) };
}

/**
 * Everything a service's code gets. With the workspace's config and registry, it can also
 * follow references into other enabled services.
 */
export function serviceContext(
  root: string,
  entry: ServiceEntry,
  scope: Scope,
  out: Output,
  workspace?: { config: ProjectConfig; registry: Registry },
): ServiceContext {
  const plugin = entry.plugin.name;
  const configured = workspace?.config.services.find((s) => s.service === entry.key);
  return {
    ...pluginContext(root, out),
    root,
    settings: { fetch: configured?.fetch ?? "within-scope", sync: configured?.sync ?? "full" },
    folder: entry.service.role === "connected" ? path.join(root, entry.service.id) : null,
    scope,
    credentials() {
      const saved = loadCredentials(plugin);
      if (!saved) {
        throw new DevError(
          `You're not logged in to ${entry.plugin.title}.`,
          `Run "dev login ${plugin}" yourself. Agents: ask the person to run it.`,
        );
      }
      return saved.credentials;
    },
    async references(text) {
      if (!workspace) return [];
      const { config, registry } = workspace;
      return resolveReferences(
        {
          root,
          config,
          registry,
          out,
          contextFor: (other) => serviceContext(root, other, config.services.find((s) => s.service === other.key)?.scope ?? {}, out, workspace),
        },
        text,
        entry.key,
      );
    },
  };
}

/** The context for an enabled service, with its scope from dev.yaml. */
export function workspaceServiceContext(root: string, entry: ServiceEntry, config: ProjectConfig, registry: Registry, out: Output): ServiceContext {
  const scope = config.services.find((s) => s.service === entry.key)?.scope ?? {};
  return serviceContext(root, entry, scope, out, { config, registry });
}
