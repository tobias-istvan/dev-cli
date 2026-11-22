import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitClone } from "../../src/core/run.ts";
import type { ChangeRequest, Plugin } from "../../src/plugins/types.ts";

/**
 * A plugin for tests: "example" offers a versioning service and two connected
 * services, and never reaches the network. DEV_EXAMPLE_PRS stands in for its pull requests. A login is valid when its token is "good".
 */
const plugin: Plugin = {
  name: "example",
  title: "Example",
  description: "A plugin for tests",
  login: {
    methods: [{ kind: "token", title: "Token" }],
    async login() {
      return { account: "tester", credentials: { token: "good" } };
    },
    async check(_context, credentials) {
      return credentials.token === "good"
        ? { ok: true, account: "tester" }
        : { ok: false, problem: { message: "Example rejected the token.", fix: 'Run "dev login example".' } };
    },
  },
  secrets: (credentials) => [credentials.token ?? ""],
  services: [
    {
      id: "code",
      title: "Example code",
      description: "Hosts the repository",
      role: "versioning",
      scope: { describe: () => "the repository", choose: async () => ({}), validate: () => [] },
      versioning: {
        listRepositories: async () => [{ id: "acme/web" }],
        cloneUrl: (repository) => `https://example.test/${repository}.git`,
        clone: (_context, _credentials, repository, target, url) => gitClone(url ?? `https://example.test/${repository}.git`, target),
        // DEV_EXAMPLE_PRS: the pull requests for each branch, as JSON, newest first.
        changeRequests: async (_context, _credentials, _repository, branch) => (JSON.parse(process.env.DEV_EXAMPLE_PRS ?? "{}") as Record<string, ChangeRequest[]>)[branch] ?? [],
      },
    },
    {
      id: "notes",
      title: "Example notes",
      description: "Team notes",
      role: "connected",
      scope: {
        describe: (scope) => `book ${String(scope.book)}`,
        choose: async () => ({ book: "team" }),
        validate: (scope) =>
          typeof scope.book === "string" ? [] : [{ message: 'needs a "book".', fix: 'Add book: <name> to its scope.' }],
      },
      commands: [
        {
          name: "list",
          description: "List the notes in scope",
          mark: "read",
          async run(context) {
            context.out.info(`book=${String(context.scope.book)} folder=${context.folder}`);
          },
        },
        {
          name: "post",
          description: "Post a note",
          mark: "change",
          writes: true,
          arguments: ["<text>"],
          options: [{ flags: "--pin", description: "Pin it" }],
          async run(context, args, options) {
            context.credentials();
            writeFileSync(path.join(context.folder ?? context.root, "posted.txt"), `${args[0]} pin=${String(options.pin ?? false)}`);
          },
        },
      ],
      async sync(context) {
        const folder = context.folder ?? context.root;
        mkdirSync(folder, { recursive: true });
        if (String(context.scope.book) === "broken") throw new Error("The book is gone.");
        writeFileSync(path.join(folder, "N-5.md"), "---\nid: N-5\ntitle: Synced note\nservice: example:notes\nurl: https://example.test/N-5\nupdated: 2026-11-07\nsynced: 2026-11-08\n---\n\nText\n");
        return { added: 1, updated: 0, removed: 0, failed: [] };
      },
      links: {
        find: (text) => [...text.matchAll(/\bN-\d+\b/g)].map((m) => ({ service: "example:notes", id: m[0] })),
        async fetch(context, reference) {
          const file = path.join(context.folder ?? context.root, `${reference.id}.md`);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, `# ${reference.id}\n\nFix the login button. See N-2.\n`);
          return file;
        },
      },
      contribute: {
        async snapshot() {
          return "## Example notes\n\n- N-5 needs an answer";
        },
        async sessionStart() {
          return ["Notes waiting: N-5."];
        },
        async dayEnd() {
          return ["- 1 note changed"];
        },
        async taskStart(context, reference) {
          return {
            title: `Fix the login button`,
            type: "fix",
            files: [path.join(path.basename(context.folder ?? ""), `${reference.id}.md`)],
            references: reference.id === "N-1" ? [{ service: "example:notes", id: "N-2" }] : [],
          };
        },
      },
      agentFiles: {
        skills: [{ name: "example-notes", description: "Read team notes. Use when a task mentions a note.", body: "# Notes\n\nRead notes/index.md first." }],
        docs: [{ file: "example-notes.md", content: "# Example notes\n\nHow notes are synced." }],
        rules: ["Never post a note unless the person asks."],
        gitignore: ["notes/.cache/"],
        mcp: [{ name: "example", server: { command: "example-mcp" } }],
      },
    },
    {
      id: "boards",
      title: "Example boards",
      description: "Planning boards",
      role: "connected",
      scope: { describe: () => "all", choose: async () => ({}), validate: () => [] },
      commands: [{ name: "show", description: "Show a board", mark: "read", async run() {} }],
    },
  ],
};

export default plugin;
