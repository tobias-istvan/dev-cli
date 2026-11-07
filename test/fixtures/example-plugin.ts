import { writeFileSync } from "node:fs";
import path from "node:path";
import { gitClone } from "../../src/core/run.ts";
import type { Plugin } from "../../src/plugins/types.ts";

/**
 * A plugin for tests: "example" offers a versioning service and two connected
 * services, and never reaches the network. A login is valid when its token is "good".
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
          arguments: ["<text>"],
          options: [{ flags: "--pin", description: "Pin it" }],
          async run(context, args, options) {
            context.credentials();
            writeFileSync(path.join(context.folder ?? context.root, "posted.txt"), `${args[0]} pin=${String(options.pin ?? false)}`);
          },
        },
      ],
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
