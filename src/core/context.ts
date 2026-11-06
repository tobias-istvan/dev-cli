import path from "node:path";
import type { Output, PluginContext, Scope, ServiceContext, ServiceEntry } from "../plugins/types.ts";
import { loadCredentials } from "./credentials.ts";
import { DevError } from "./output.ts";

export function pluginContext(root: string | null, out: Output): PluginContext {
  return { root, out, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) };
}

export function serviceContext(root: string, entry: ServiceEntry, scope: Scope, out: Output): ServiceContext {
  const plugin = entry.plugin.name;
  return {
    ...pluginContext(root, out),
    root,
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
  };
}
