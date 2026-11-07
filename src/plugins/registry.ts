import { pathToFileURL } from "node:url";
import atlassian from "./atlassian/index.ts";
import figma from "./figma/index.ts";
import github from "./github/index.ts";
import type { Plugin, Problem, ServiceEntry } from "./types.ts";

/**
 * The plugins this dev knows. Version 0.x ships them inside the package.
 *
 * DEV_EXTRA_PLUGINS lists module paths to load as well, separated by the path delimiter.
 * It exists for developing and testing plugins: those modules run with the person's
 * credentials, like any plugin.
 */

const BUILT_IN: Plugin[] = [github, atlassian, figma];

export class Registry {
  readonly plugins: Plugin[];

  constructor(plugins: Plugin[]) {
    this.plugins = plugins;
  }

  /** Every service, with its plugin and its "<plugin>:<service>" key. */
  services(): ServiceEntry[] {
    return this.plugins.flatMap((plugin) =>
      plugin.services.map((service) => ({ plugin, service, key: `${plugin.name}:${service.id}` })),
    );
  }

  plugin(name: string): Plugin | undefined {
    return this.plugins.find((plugin) => plugin.name === name);
  }

  /** A service by its key, like "atlassian:jira", or by its short id, like "jira". */
  service(name: string): ServiceEntry | undefined {
    return this.services().find((entry) => entry.key === name || entry.service.id === name);
  }

  /** Mistakes in the plugins themselves. A plugin author's problem, not the person's. */
  problems(): Problem[] {
    const problems: Problem[] = [];
    const names = new Set<string>();
    const ids = new Map<string, string>();

    for (const plugin of this.plugins) {
      if (!/^[a-z][a-z0-9-]*$/.test(plugin.name)) problems.push({ message: `Plugin name "${plugin.name}" must be lowercase letters, digits and hyphens.` });
      if (names.has(plugin.name)) problems.push({ message: `Two plugins are called "${plugin.name}".` });
      names.add(plugin.name);

      for (const service of plugin.services) {
        if (!/^[a-z][a-z0-9-]*$/.test(service.id)) problems.push({ message: `Service id "${service.id}" in ${plugin.name} must be lowercase letters, digits and hyphens.` });
        const other = ids.get(service.id);
        if (other) problems.push({ message: `Service id "${service.id}" is used by both ${other} and ${plugin.name}.` });
        ids.set(service.id, plugin.name);
        if (service.role === "versioning" && !service.versioning) {
          problems.push({ message: `${plugin.name}:${service.id} is a versioning service without the versioning capability.` });
        }
      }
    }
    return problems;
  }
}

async function extraPlugins(): Promise<Plugin[]> {
  const list = process.env.DEV_EXTRA_PLUGINS;
  if (!list) return [];

  const plugins: Plugin[] = [];
  for (const file of list.split(process.platform === "win32" ? ";" : ":").filter(Boolean)) {
    const module = (await import(pathToFileURL(file).href)) as { default?: Plugin | Plugin[] };
    const exported = module.default;
    if (!exported) throw new Error(`${file} has no default export.`);
    plugins.push(...(Array.isArray(exported) ? exported : [exported]));
  }
  return plugins;
}

export async function loadRegistry(): Promise<Registry> {
  return new Registry([...BUILT_IN, ...(await extraPlugins())]);
}
