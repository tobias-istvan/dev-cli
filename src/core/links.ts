import { existsSync } from "node:fs";
import path from "node:path";
import type { Output, Reference, ServiceEntry } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { OutsideScope } from "./output.ts";
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

export async function resolveReferences(tools: LinkTools, text: string, exclude?: string): Promise<Array<{ reference: Reference; file: string | null; outside?: boolean }>> {
  const results: Array<{ reference: Reference; file: string | null; outside?: boolean }> = [];
  const seen = new Set<string>();

  const enabled = new Set(tools.config.services.map((s) => s.service));
  for (const entry of tools.registry.services()) {
    if (!enabled.has(entry.key) || entry.key === exclude || !entry.service.links) continue;

    const context = tools.contextFor(entry);
    for (const reference of entry.service.links.find(text, context)) {
      const key = `${reference.service}:${reference.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const file = await entry.service.links.fetch(context, reference);
        results.push({ reference, file: existsSync(file) ? path.relative(tools.root, file) : null });
      } catch (error) {
        if (error instanceof OutsideScope) {
          results.push({ reference, file: null, outside: true });
          continue;
        }
        tools.out.warn(`Couldn't fetch ${reference.id} from ${entry.service.title}: ${(error as Error).message}`);
        results.push({ reference, file: null });
      }
    }
  }
  return results;
}
