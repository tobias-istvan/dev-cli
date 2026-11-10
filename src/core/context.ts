import { safePath } from "./files.ts";
import type { Output, PluginContext, Scope, ServiceContext, ServiceEntry } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { loadCredentials } from "./credentials.ts";
import { createLocalizer, resolveReferences } from "./links.ts";
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
  const tools = workspace && {
    root,
    config: workspace.config,
    registry: workspace.registry,
    out,
    contextFor: (other: ServiceEntry) => serviceContext(root, other, workspace.config.services.find((s) => s.service === other.key)?.scope ?? {}, out, workspace),
  };
  let localizer: ReturnType<typeof createLocalizer> | undefined;
  return {
    ...pluginContext(root, out),
    root,
    fetched: new Map(),
    settings: { fetch: configured?.fetch ?? "within-scope", sync: configured?.sync ?? "full" },
    folder: entry.service.role === "connected" ? safePath(root, entry.service.id) : null,
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
      return tools ? resolveReferences(tools, text, entry.key) : [];
    },
    async localize(body, file) {
      if (!tools) return body;
      localizer ??= createLocalizer(tools);
      return localizer(body, file);
    },
  };
}

/** The context for an enabled service, with its scope from dev.yaml. */
export function workspaceServiceContext(root: string, entry: ServiceEntry, config: ProjectConfig, registry: Registry, out: Output): ServiceContext {
  const scope = config.services.find((s) => s.service === entry.key)?.scope ?? {};
  return serviceContext(root, entry, scope, out, { config, registry });
}
