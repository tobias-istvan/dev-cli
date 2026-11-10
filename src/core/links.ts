import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Output, Reference, Service, ServiceContext, ServiceEntry } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { atomicWrite, atomicWriteSync, safePath } from "./files.ts";
import { readFile } from "node:fs/promises";
import { splitFrontMatter } from "./front-matter.ts";
import { OutsideScope } from "./output.ts";
import type { ProjectConfig } from "./project-config.ts";

/**
 * Following references between services: a PR naming a ticket, a ticket linking a spec.
 * Each enabled service recognises its own references; this asks all of them, fetches what
 * isn't already in the workspace, and points links in mirrored files at the local copies.
 */

export interface LinkTools {
  root: string;
  config: ProjectConfig;
  registry: Registry;
  out: Output;
  /** Builds a context for another service, so its fetch can run. */
  contextFor(entry: ServiceEntry): ServiceContext;
}

export interface Resolved {
  reference: Reference;
  file: string | null;
  outside?: boolean;
  /** For one outside the scope: the command that brings it in. */
  command?: string;
}

/** The exact command that adds a reference to its service's scope. */
export function scopeCommand(service: Service, reference: Reference): string {
  if (!service.scope.add) return `dev ${service.id} scope`;
  const target = reference.url ?? reference.id;
  return `dev ${service.id} scope add ${/^[\w@%+=:,./#-]+$/.test(target) ? target : `'${target.replace(/'/g, "'\\''")}'`}`;
}

export async function resolveReferences(tools: LinkTools, text: string, exclude?: string): Promise<Resolved[]> {
  const results: Resolved[] = [];
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
          results.push({ reference, file: null, outside: true, command: scopeCommand(entry.service, reference) });
          continue;
        }
        tools.out.warn(`Couldn't fetch ${reference.id} from ${entry.service.title}: ${(error as Error).message}`);
        results.push({ reference, file: null });
      }
    }
  }
  return results;
}

/** A link outside the scope, as a brief or a PR lists it: the link, and how to bring it in. */
export function describeOutside(found: Resolved): string {
  const link = found.reference.url ?? found.reference.id;
  return found.command ? `${link} (to fetch it: \`${found.command}\`, then \`dev sync\`)` : link;
}

// ---------------------------------------------------------------------------
// What's outside the scope

/**
 * The references the last sync found outside each service's scope, by service key. Kept so
 * a mirrored file can say so next to its links without asking the service again.
 */
export type OutsideState = Record<string, string[]>;

function outsideFile(root: string): string {
  return safePath(root, ".dev/state/outside-scope.json");
}

export function readOutside(root: string): OutsideState {
  try {
    const value: unknown = JSON.parse(readFileSync(outsideFile(root), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as OutsideState) : {};
  } catch {
    return {};
  }
}

export function writeOutside(root: string, state: OutsideState): void {
  atomicWriteSync(outsideFile(root), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Local links

/**
 * A lookup of what a service has on disk, by id, for `links.local`. The folder is scanned
 * once per context, and again when something isn't found, at most every couple of seconds,
 * so a page full of links to things that aren't here doesn't scan once per link.
 */
export function localLookup(scan: (context: ServiceContext) => Promise<Map<string, string>>): (context: ServiceContext, id: string) => Promise<string | null> {
  const scans = new WeakMap<ServiceContext, { at: number; files: Map<string, string> }>();
  return async (context, id) => {
    let known = scans.get(context);
    const hit = known?.files.get(id);
    if (hit && existsSync(hit)) return hit;
    if (!known || Date.now() - known.at > 2000) {
      known = { at: Date.now(), files: await scan(context) };
      scans.set(context, known);
    }
    return known.files.get(id) ?? null;
  };
}

const URL_PATTERN = String.raw`https?:\/\/(?:[^\s()<>"\]\\]|\((?:[^\s()<>"])*\))+`;
/** A Markdown link, an autolink, or a bare URL. Images are matched so they're left alone. */
const LINKS = new RegExp(String.raw`(!?)\[((?:[^\[\]\\]|\\.|\[[^\[\]]*\])*)\]\(\s*<?(${URL_PATTERN})>?(?:\s+"[^"]*")?\s*\)|<(${URL_PATTERN})>|(?<![\w/"'(<\[=])(${URL_PATTERN})`, "g");
const CODE = /((?:^|\n)[ \t]*(?:```|~~~)[\s\S]*?(?:\n[ \t]*(?:```|~~~)[^\n]*|$)|`[^`\n]+`)/;
/** A link this module made local: the original address is kept as the link's title. */
const LOCALIZED = /\]\((?!https?:)[^()\s]+ "(https?:\/\/[^"\s]+)"\)/g;
const OUTSIDE_MARK = "<!-- dev:outside-scope -->";
const OUTSIDE_SECTION = /\n*<!-- dev:outside-scope -->[\s\S]*$/;

type Target = { file: string } | { command: string } | null;

/**
 * Points the links in a mirrored file's body at local copies, wherever a link leads to
 * something an enabled service has in the workspace. `[spec](https://…/pages/12)` becomes
 * `[spec](../../confluence/DOCS/Spec-12/index.md "https://…/pages/12")`: the address stays
 * as the title, so a later pass can redo the link when the copy moves or goes. Links the
 * last sync found outside a scope are listed at the end, each with the command that adds it.
 *
 * Nothing is fetched, and the same body on the same disk always gives the same text, so a
 * sync that renders a file again finds it unchanged.
 */
export function createLocalizer(tools: LinkTools): (body: string, file: string) => Promise<string> {
  const enabled = new Set(tools.config.services.map((s) => s.service));
  const entries = tools.registry.services().filter((entry) => enabled.has(entry.key) && entry.service.links);
  const contexts = new Map<string, ServiceContext>();
  const targets = new Map<string, Target>();
  const titles = new Map<string, string>();
  let outside: OutsideState | null = null;

  const lookup = async (url: string): Promise<Target> => {
    const plain = url.replace(/&amp;/g, "&");
    for (const entry of entries) {
      const context = contexts.get(entry.key) ?? tools.contextFor(entry);
      contexts.set(entry.key, context);
      // Only what the service recognised as a link counts, not a lookalike key inside another address.
      const reference = entry.service.links!.find(plain, context).find((r) => r.url && plain.startsWith(r.url.replace(/&amp;/g, "&")));
      if (!reference) continue;
      const file = await entry.service.links!.local?.(context, reference);
      if (file) return { file };
      outside ??= readOutside(tools.root);
      return outside[entry.key]?.includes(reference.id) ? { command: scopeCommand(entry.service, reference) } : null;
    }
    return null;
  };
  // Only finds are remembered: something that isn't here yet may be fetched a moment later.
  const target = async (url: string): Promise<Target> => {
    const known = targets.get(url);
    if (known) return known;
    const found = await lookup(url).catch(() => null);
    if (found && "file" in found) targets.set(url, found);
    return found;
  };
  const titleOf = (file: string): string => {
    if (!titles.has(file)) {
      let title = "";
      try { title = String(splitFrontMatter(readFileSync(file, "utf8")).data?.title ?? ""); } catch {}
      titles.set(file, title.replace(/[\[\]\r\n]/g, " ").trim());
    }
    return titles.get(file)!;
  };

  return async (body, file) => {
    // Back to the original addresses first, so the result doesn't depend on an earlier pass.
    const text = body.replace(OUTSIDE_SECTION, "").replace(LOCALIZED, "]($1)").trim();
    const parts = text.split(CODE);
    const found = new Map<string, Target>();
    for (let i = 0; i < parts.length; i += 2) {
      for (const match of parts[i]!.matchAll(LINKS)) {
        if (match[1]) continue;
        const url = match[3] ?? match[4] ?? trimmed(match[5] ?? "");
        if (!found.has(url)) found.set(url, await target(url));
      }
    }
    if (![...found.values()].some(Boolean)) return text;

    const local = (url: string): string | null => {
      const to = found.get(url);
      if (!to || !("file" in to)) return null;
      const relative = path.relative(path.dirname(file), to.file).split(path.sep).join("/");
      return `${encodeURI(relative).replace(/\(/g, "%28").replace(/\)/g, "%29")} "${url.replace(/"/g, "%22")}"`;
    };
    const label = (url: string): string => {
      const to = found.get(url);
      return (to && "file" in to && titleOf(to.file)) || url;
    };
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i]!.replace(LINKS, (whole, image: string, words: string, linked?: string, auto?: string, bare?: string) => {
        if (image) return whole;
        if (linked) return local(linked) ? `[${words}](${local(linked)})` : whole;
        if (auto) return local(auto) ? `[${label(auto)}](${local(auto)})` : whole;
        const url = trimmed(bare ?? "");
        return local(url) ? `[${label(url)}](${local(url)})${(bare ?? "").slice(url.length)}` : whole;
      });
    }

    const commands = [...new Set([...found.values()].flatMap((to) => (to && "command" in to ? [to.command] : [])))];
    const section =
      commands.length > 0
        ? `\n\n${OUTSIDE_MARK}\n## Outside the scope\n\nLinked above, but outside this workspace's scope, so not fetched. To fetch one, run its command, then \`dev sync\`:\n\n${commands.map((command) => `- \`${command}\``).join("\n")}`
        : "";
    return `${parts.join("")}${section}`;
  };
}

/** Redoes the links in one mirrored file, like after something it points to was fetched. Returns whether it changed. */
export async function localizeFile(file: string, localize: (body: string, file: string) => Promise<string>): Promise<boolean> {
  const text = await readFile(file, "utf8");
  const { data, body } = splitFrontMatter(text);
  if (!data) return false;
  const next = await localize(body, file);
  if (next === body.trim()) return false;
  await atomicWrite(file, `${text.slice(0, text.length - body.length)}\n${next}\n`);
  return true;
}

/** A bare URL without the punctuation of the sentence around it. */
function trimmed(url: string): string {
  return url.replace(/[.,;:!?'*_]+$/, "");
}
