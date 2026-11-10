import { atomicWrite } from "../../core/files.ts";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, Reference, Service, ServiceContext, SyncReport } from "../types.ts";
import { renderItem, splitFrontMatter, type CommonFields, type Via } from "../../core/front-matter.ts";
import { buildIndex } from "../../core/indexes.ts";
import { DevError, OutsideScope, describeError } from "../../core/output.ts";
import { secret } from "../../core/prompt.ts";
import { mcpAvailable, mcpUrl, restNodes, whoAmI } from "./remote.ts";

/**
 * Figma: designs that tickets, issues and PRs link to. Each becomes a small item,
 * figma/<fileKey>-<nodeId>/design.md, saying which frame it is and how to read it through
 * the local Figma MCP. Agents read the design itself there, never from the web URL.
 *
 * A sync fingerprints each frame through the REST API with a token. Desktop metadata
 * remains unverified because the MCP server cannot establish file identity.
 */

const SERVICE = "figma:figma";
const DESIGN = "design.md";

interface Link {
  fileKey: string;
  nodeId: string;
  fileSlug: string;
  url: string;
}

/** A Figma link's file and frame. Branch links use the branch's key, as the MCP expects. */
export function parseLink(url: string): Link | null {
  const match = url.match(/https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?(?:\/([^?#\s)]*))?(\?[^#\s)]*)?/);
  if (!match?.[1]) return null;
  const query = (match[4] ?? "").replace(/&amp;/g, "&");
  const node = decodeURIComponent(new URLSearchParams(query.slice(1)).get("node-id") ?? "").replace("-", ":");
  return {
    fileKey: match[2] ?? match[1],
    nodeId: /^\d+:\d+$/.test(node) ? node : "",
    fileSlug: decodeURIComponent(match[3] ?? "").replace(/-/g, " ").trim(),
    url: match[0].replace(/&amp;/g, "&").replace(/[.,;]+$/, ""),
  };
}

function itemId(link: { fileKey: string; nodeId: string }): string {
  return link.nodeId ? `${link.fileKey}:${link.nodeId}` : link.fileKey;
}

function folder(context: ServiceContext): string {
  return context.folder ?? path.join(context.root, "figma");
}

function file(context: ServiceContext, link: { fileKey: string; nodeId: string }): string {
  return path.join(folder(context), link.nodeId ? `${link.fileKey}-${link.nodeId.replace(":", "-")}` : link.fileKey, DESIGN);
}

function token(context: ServiceContext): string | null {
  try {
    return context.credentials().token ?? null;
  } catch {
    return null;
  }
}

function body(data: Record<string, unknown>): string {
  const node = String(data.nodeId ?? "");
  const changes = data.changed ? `Last seen changing: ${String(data.changed).slice(0, 16).replace("T", " ")}.` : "No change seen since it was first recorded.";
  return [
    `# ${String(data.title)}`,
    "",
    `Figma file \`${String(data.fileKey)}\`${data.fileName ? ` (${String(data.fileName)})` : ""}${node ? `, frame \`${node}\`` : ""}.`,
    "",
    "## How to read it",
    "",
    node
      ? `Use the local Figma MCP with node id \`${node}\`, with the file open in the Figma desktop app. Call get_design_context for the design, or get_metadata for its structure.`
      : "Use the local Figma MCP, with the file open in the Figma desktop app. The link names no frame, so ask the person which one, or check the ticket.",
    "",
    "Never fetch the web link. It's for people:",
    "",
    String(data.url),
    "",
    "## Changes",
    "",
    changes,
  ].join("\n");
}

async function save(target: string, data: CommonFields & Record<string, unknown>): Promise<void> {
  await atomicWrite(target, renderItem(data, body(data)));
}

async function localItems(context: ServiceContext): Promise<Array<{ file: string; data: Record<string, unknown> }>> {
  if (!existsSync(folder(context))) return [];
  const items: Array<{ file: string; data: Record<string, unknown> }> = [];
  for (const entry of await readdir(folder(context), { withFileTypes: true })) {
    const target = path.join(folder(context), entry.name, DESIGN);
    if (!entry.isDirectory() || !existsSync(target)) continue;
    const { data } = splitFrontMatter(await readFile(target, "utf8"));
    if (data) items.push({ file: target, data });
  }
  return items;
}

const INDEX: NonNullable<Service["index"]> = { folder: "figma", title: "Figma designs", include: (f) => path.posix.basename(f) === DESIGN };

function index(context: ServiceContext): void {
  if (context.deferIndex) return;
  if (existsSync(folder(context))) buildIndex(folder(context), INDEX.title, INDEX.include);
}

function scopeFiles(context: ServiceContext): string[] {
  return Array.isArray(context.scope.files) ? context.scope.files.map(String) : [];
}

/** Records a design the first time something links to it. No network needed. */
async function record(context: ServiceContext, reference: Reference, via: Via): Promise<string> {
  const link = parseLink(reference.url ?? "");
  if (!link) throw new DevError(`"${reference.url ?? reference.id}" isn't a Figma design link.`);
  const files = scopeFiles(context);
  if (context.settings.fetch === "within-scope" && files.length > 0 && !files.includes(link.fileKey)) throw new OutsideScope(`Figma file ${link.url}`);

  const target = file(context, link);
  if (existsSync(target)) return target;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(target), { recursive: true });
  const now = new Date().toISOString();
  await save(target, {
    id: itemId(link),
    title: link.fileSlug || link.fileKey,
    service: SERVICE,
    url: link.url,
    updated: now,
    synced: now,
    fileKey: link.fileKey,
    nodeId: link.nodeId,
    inScope: false,
    via,
  });
  index(context);
  return target;
}

/**
 * Fingerprints recorded designs with the REST API. Desktop metadata is only an unverified
 * availability check and cannot update authoritative change-detection state.
 */
async function check(context: ServiceContext): Promise<SyncReport> {
  const report: SyncReport = { added: 0, updated: 0, removed: 0, failed: [] };
  const items = (await localItems(context)).filter((item) => context.settings.fetch === "anywhere" || scopeFiles(context).length === 0 || scopeFiles(context).includes(String(item.data.fileKey)));
  if (items.length === 0) return report;

  const now = new Date().toISOString();
  const key = token(context);
  const changed: string[] = [];
  const unchecked: Array<Record<string, unknown>> = [];

  const apply = async (item: { file: string; data: Record<string, unknown> }, state: { fingerprint: string; nodeName: string; fileName?: string; lastModified?: string }, via: "rest" | "mcp") => {
    const data = item.data;
    const sameMethod = data.fingerprintVia === via;
    const moved = sameMethod && typeof data.fingerprint === "string" && data.fingerprint !== state.fingerprint;
    const next = {
      ...(data as unknown as CommonFields),
      title: state.nodeName || String(data.title),
      updated: state.lastModified ?? String(data.updated),
      synced: now,
      ...(state.fileName ? { fileName: state.fileName } : {}),
      nodeName: state.nodeName,
      fingerprint: state.fingerprint,
      fingerprintVia: via,
      ...(moved ? { changed: now } : {}),
    };
    if (moved) changed.push(String(next.title));
    // Rewrite only when something other than the sync time moved.
    const { synced: _s, ...before } = data;
    const { synced: _n, ...after } = next as Record<string, unknown>;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await save(item.file, next);
      report.updated += moved ? 1 : 0;
    }
  };

  if (key) {
    const byFile = new Map<string, Array<{ file: string; data: Record<string, unknown> }>>();
    for (const item of items) byFile.set(String(item.data.fileKey), [...(byFile.get(String(item.data.fileKey)) ?? []), item]);
    for (const [fileKey, group] of byFile) {
      try {
        const states = await restNodes(key, fileKey, group.map((i) => String(i.data.nodeId ?? "")));
        for (const item of group) {
          const state = states.get(String(item.data.nodeId));
          if (state) await apply(item, state, "rest");
          else if (item.data.nodeId) report.failed.push({ id: String(item.data.id), reason: "the frame no longer exists in Figma" });
        }
      } catch (error) {
        report.failed.push({ id: fileKey, reason: describeError(error) });
      }
    }
  } else if (await mcpAvailable()) {
    // Desktop metadata does not prove which file is open, so it's never asked for a frame:
    // the answer couldn't overwrite verified state.
    unchecked.push(...items.filter((item) => item.data.nodeId).map((item) => item.data));
    if (unchecked.length > 0) {
      // Grouped by file, with a link to open it, since one open file checks all its frames.
      const byFile = new Map<string, Array<Record<string, unknown>>>();
      for (const data of unchecked) byFile.set(String(data.fileKey), [...(byFile.get(String(data.fileKey)) ?? []), data]);
      context.out.info(
        `  Figma: ${unchecked.length} design${unchecked.length === 1 ? "" : "s"} not checked, since ${byFile.size === 1 ? "this file isn't" : "these files aren't"} open in Figma desktop:`,
      );
      for (const [fileKey, designs] of byFile) {
        const first = designs[0] ?? {};
        const name = String(first.fileName ?? "") || parseLink(String(first.url))?.fileSlug || fileKey;
        context.out.info(`    ${name}: https://www.figma.com/design/${fileKey}`);
        for (const data of designs) context.out.info(`      ${String(data.title)}${data.nodeId ? ` (frame ${String(data.nodeId)})` : ""}`);
      }
      context.out.info("  Open a file in Figma desktop and run \"dev figma check\" to check its designs.");
    }
  } else {
    context.out.info('  Figma: designs not checked for changes. Log in with a token ("dev login figma"), or open Figma desktop with its MCP server on.');
  }

  for (const title of changed) context.out.info(`  Design changed: ${title}`);
  index(context);
  return report;
}

export const figmaService: Service = {
  id: "figma",
  title: "Figma",
  index: INDEX,
  description: "Designs that tickets and PRs link to, read through the local Figma MCP",
  role: "connected",

  scope: {
    describe: (scope) => (Array.isArray(scope.files) && scope.files.length > 0 ? `designs in ${scope.files.length} file${scope.files.length === 1 ? "" : "s"}` : "any design that tasks link to"),
    choose: async () => ({}),
    validate(scope) {
      if (scope.files !== undefined && (!Array.isArray(scope.files) || !scope.files.every((f) => /^[A-Za-z0-9]+$/.test(String(f))))) {
        return [{ message: '"files" should be a list of Figma file keys.' }];
      }
      return [];
    },
    add(scope, items) {
      const list = Array.isArray(scope.files) ? scope.files.map(String) : [];
      const added: string[] = [];
      const problems = [];
      for (const item of items) {
        const key = parseLink(item)?.fileKey ?? (/^[A-Za-z0-9]{10,}$/.test(item) ? item : null);
        if (!key) problems.push({ message: `"${item}" isn't a Figma link or file key.` });
        else if (!list.includes(key) && !added.includes(key)) added.push(key);
      }
      return { scope: { ...scope, files: [...list, ...added] }, added, problems };
    },
  },

  sync: check,
  refresh: check,

  links: {
    find(text) {
      const found = new Map<string, Reference>();
      for (const match of text.matchAll(/https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[^\s)<>"'\]]+/g)) {
        const link = parseLink(match[0]);
        if (link && !found.has(itemId(link))) found.set(itemId(link), { service: SERVICE, id: itemId(link), url: link.url });
      }
      return [...found.values()];
    },
    fetch: (context, reference) => record(context, reference, "linked"),
    async local(context, reference) {
      const link = parseLink(reference.url ?? "");
      return link && existsSync(file(context, link)) ? file(context, link) : null;
    },
  },

  contribute: {
    async snapshot(context) {
      const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recent = (await localItems(context)).filter((i) => typeof i.data.changed === "string" && Date.parse(i.data.changed) > week);
      if (recent.length === 0) return null;
      return [
        "## Designs changed this week",
        "",
        ...recent.map((i) => `- [${String(i.data.title)}](figma/${path.basename(path.dirname(i.file))}/${DESIGN}) changed ${String(i.data.changed).slice(0, 10)}`),
        "",
        "Check the tasks that link to them: the implementation may need to follow.",
      ].join("\n");
    },
  },

  commands: [
    {
      name: "check",
      description: "Check the recorded designs for changes now",
      mark: "read",
      writes: true,
      async run(context) {
        const report = await check(context);
        if (report.failed.length > 0) process.exitCode = 1;
        context.out.info(`Done: ${report.updated} design${report.updated === 1 ? "" : "s"} changed.`);
        for (const failure of report.failed) context.out.warn(`  ${failure.id}: ${failure.reason}`);
      },
    },
    {
      name: "pull",
      description: "Record a design from its Figma link",
      mark: "read",
      writes: true,
      arguments: ["<link>"],
      async run(context, args) {
        const target = await record(context, { service: SERVICE, id: args[0] ?? "", url: args[0] }, "pulled");
        context.out.info(path.relative(context.root, target));
      },
    },
  ],

  agentFiles: {
    skills: [
      {
        name: "figma-designs",
        description: "Read a Figma design a ticket or PR links to. Use when a task mentions a Figma link or a design under figma/.",
        body: `# Reading Figma designs

Designs a task links to are recorded in \`figma/<file>-<node>/design.md\`, with the file key
and the frame's node id. Start at \`figma/index.md\`.

1. Read the design's \`design.md\` for its node id.
2. Ask the person to open the file in the Figma desktop app, if it isn't open.
3. Call the local Figma MCP: \`get_design_context\` with that node id for the design, or
   \`get_metadata\` for its structure. It gives the real layers, tokens and spacing.

Never fetch the figma.com link: it's for people, and gives you a picture, not the design.

The front matter's \`changed\` says when dev last saw the frame change. If it's after the
work started, check the implementation still matches.`,
      },
    ],
    rules: ["Read Figma designs through the local Figma MCP, using the node id in figma/<item>/design.md. Never fetch a figma.com link."],
    mcp: [{ name: "figma-desktop", server: { type: "http", url: mcpUrl() } }],
  },
};

const figma: Plugin = {
  name: "figma",
  title: "Figma",
  description: "Figma designs",
  login: {
    methods: [{ kind: "token", title: "Personal access token" }],
    optional: { benefit: "dev can check designs for changes without Figma desktop running" },
    async login(context) {
      context.out.info('Create a token in Figma: Settings > Security > Personal access tokens. It only needs "File content: read".');
      const value = (await secret("Figma token (hidden as you type):", "a terminal")).trim();
      if (!value) throw new DevError("No token was entered.");
      return { account: await whoAmI(value), credentials: { token: value } };
    },
    async check(_context, credentials) {
      try {
        return { ok: true, account: await whoAmI(credentials.token ?? "") };
      } catch (error) {
        return { ok: false, problem: { message: (error as Error).message, fix: 'Run "dev login figma" again.' } };
      }
    },
  },
  secrets: (credentials) => (credentials.token ? [credentials.token] : []),
  services: [figmaService],
};

export default figma;
