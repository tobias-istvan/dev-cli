import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { updateFields } from "../../src/core/front-matter.ts";
import type { Plugin, ServiceContext } from "../../src/plugins/types.ts";

/**
 * A plugin for change-record tests: "recorded" mirrors items from a folder the test edits,
 * DEV_RECORDED_REMOTE, the way a real service mirrors its API.
 *
 *   tickets: <remote>/tickets/<ID>.md becomes tickets/<ID>/ticket.md. A ticket that's gone
 *            from the remote stays, marked out of scope.
 *   pages:   <remote>/pages/ is copied as it is, so a page whose path changes moves and one
 *            that's gone is removed.
 *
 * Every write stamps a new `synced`, as real syncs do. DEV_RECORDED_CRASH stops the process
 * after the tickets are written, like a sync that's killed.
 */
const remote = () => process.env.DEV_RECORDED_REMOTE ?? "/nonexistent";
const stamp = (text: string) => text.replace(/^synced: .*$/m, `synced: ${new Date().toISOString()}`);
const none = { describe: () => "everything", choose: async () => ({}), validate: () => [] };

/** A page's file by its id, wherever it sits. */
function pageFile(folder: string, id: string): string | null {
  if (!existsSync(folder)) return null;
  for (const name of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
    if (name.endsWith(".md") && new RegExp(`^id: ${id}$`, "m").test(readFileSync(path.join(folder, name), "utf8"))) return path.join(folder, name);
  }
  return null;
}

function ticketFile(context: ServiceContext, id: string): string {
  return path.join(context.folder!, id, "ticket.md");
}

const plugin: Plugin = {
  name: "recorded",
  title: "Recorded",
  description: "Items from a folder, for tests",
  login: {
    methods: [{ kind: "token", title: "Token" }],
    async login() {
      return { account: "tester", credentials: { token: "good" } };
    },
    async check() {
      return { ok: true, account: "tester" };
    },
  },
  services: [
    {
      id: "tickets",
      title: "Recorded tickets",
      description: "Tickets",
      role: "connected",
      scope: none,
      async sync(context) {
        const folder = path.join(remote(), "tickets");
        const live = new Set<string>();
        for (const name of existsSync(folder) ? readdirSync(folder) : []) {
          const id = name.replace(/\.md$/, "");
          live.add(id);
          mkdirSync(path.dirname(ticketFile(context, id)), { recursive: true });
          writeFileSync(ticketFile(context, id), stamp(readFileSync(path.join(folder, name), "utf8")));
        }
        for (const id of existsSync(context.folder!) ? readdirSync(context.folder!) : []) {
          if (!live.has(id) && existsSync(ticketFile(context, id))) await updateFields(ticketFile(context, id), { inScope: false, via: "former" });
        }
        if (process.env.DEV_RECORDED_CRASH) process.exit(9);
        return { added: 0, updated: live.size, removed: 0, failed: [] };
      },
      // A ticket whose status is Done is done, so a reopen can be seen.
      tasks: {
        async list(context) {
          const folder = context.folder!;
          return (existsSync(folder) ? readdirSync(folder) : []).filter((id) => existsSync(ticketFile(context, id))).map((id) => {
            const status = readFileSync(ticketFile(context, id), "utf8").match(/^status: (.*)$/m)?.[1] ?? "";
            return { id, title: id, status, done: status === "Done", mine: true, inScope: true, via: "scope", file: path.relative(context.root, ticketFile(context, id)) };
          });
        },
      },
      links: {
        find: (text) => [...text.matchAll(/\bTCK-\d+\b/g)].map((m) => ({ service: "recorded:tickets", id: m[0] })),
        async fetch(context, reference) {
          const source = path.join(remote(), "tickets", `${reference.id}.md`);
          mkdirSync(path.dirname(ticketFile(context, reference.id)), { recursive: true });
          writeFileSync(ticketFile(context, reference.id), stamp(readFileSync(source, "utf8")));
          return ticketFile(context, reference.id);
        },
      },
    },
    {
      id: "pages",
      title: "Recorded pages",
      description: "Pages",
      role: "connected",
      scope: none,
      async sync(context) {
        for (const name of existsSync(context.folder!) ? readdirSync(context.folder!) : []) {
          if (name !== "index.md") rmSync(path.join(context.folder!, name), { recursive: true });
        }
        const folder = path.join(remote(), "pages");
        if (existsSync(folder)) cpSync(folder, context.folder!, { recursive: true });
        for (const name of readdirSync(context.folder!, { recursive: true, encoding: "utf8" })) {
          const file = path.join(context.folder!, name);
          if (name.endsWith(".md") && name !== "index.md") writeFileSync(file, stamp(readFileSync(file, "utf8")));
        }
        return { added: 0, updated: 0, removed: 0, failed: [] };
      },
      links: {
        find: (text) => [...text.matchAll(/https:\/\/pages\.test\/(P-\d+)/g)].map((m) => ({ service: "recorded:pages", id: m[1]!, url: m[0] })),
        async local(context, reference) {
          return pageFile(context.folder!, reference.id);
        },
        async fetch(context, reference) {
          const file = pageFile(context.folder!, reference.id);
          if (!file) throw new Error(`${reference.id} isn't in the remote`);
          return file;
        },
      },
    },
  ],
};

export default plugin;
