import { existsSync } from "node:fs";
import path from "node:path";
import type { Output, Reference, ServiceEntry } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import type { ProjectConfig } from "./project-config.ts";

/**
 * Following references between services: a PR naming a ticket, a ticket linking a spec.
 * Each enabled service recognises its own references; this asks all of them, and fetches
 * what isn't already in the workspace.
 */

export interface LinkTools {
  root: string;
  config: ProjectConfig;
  registry: Registry;
  out: Output;
  /** Builds a context for another service, so its fetch can run. */
  contextFor(entry: ServiceEntry): import("../plugins/types.ts").ServiceContext;
}

export async function resolveReferences(tools: LinkTools, text: string, exclude?: string): Promise<Array<{ reference: Reference; file: string | null }>> {
  const results: Array<{ reference: Reference; file: string | null }> = [];
  const seen = new Set<string>();

  const enabled = new Set(tools.config.services.map((s) => s.service));
  for (const entry of tools.registry.services()) {
    if (!enabled.has(entry.key) || entry.key === exclude || !entry.service.links) continue;

    const scope = tools.config.services.find((s) => s.service === entry.key)?.scope ?? {};
    for (const reference of entry.service.links.find(text, scope)) {
      const key = `${reference.service}:${reference.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const file = await entry.service.links.fetch(tools.contextFor(entry), reference);
        results.push({ reference, file: existsSync(file) ? path.relative(tools.root, file) : null });
      } catch (error) {
        tools.out.warn(`Couldn't fetch ${reference.id} from ${entry.service.title}: ${(error as Error).message}`);
        results.push({ reference, file: null });
      }
    }
  }
  return results;
}
