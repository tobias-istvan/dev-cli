import path from "node:path";
import type { Credentials, Plugin, PluginContext } from "../types.ts";
import { DevError } from "../../core/output.ts";
import { choose, secret } from "../../core/prompt.ts";
import { gitClone } from "../../core/run.ts";
import { GitHubApi, ghAccounts, tokenFor, webBase } from "./api.ts";
import { ghPolicy } from "./policy.ts";
import { DESCRIPTION, FOLDER, indexPulls, poll, pullRequest, waitingForReview } from "./pulls.ts";
import { loadConfig } from "../../core/project-config.ts";

const REVIEW_SKILL = `# Reviewing a pull request

Review other people's PRs only, never your own.

1. Run \`dev github prs\`. It lists the open PRs that need review and pulls each into
   \`pull-requests/<N>/\`: \`pr-description.md\`, \`comments.md\`, and any linked tickets or
   specs from other services.
2. Read \`pr-description.md\`, then the linked items it lists. Read the diff with
   \`gh pr diff <N>\`, or \`gh pr diff <N> -- <path>\` for one file.
3. Check, in this order:
   - **Does it do what the linked ticket asks?** Walk each acceptance criterion.
   - **Regression risk:** changed shared code, changed exports, removed tests.
   - **The repository's own standards:** \`repository/AGENTS.md\` and its docs.
   - **Consistency** with the code around it.
4. Write \`pull-requests/<N>/review.md\`, starting with \`# PR #<N>: <title>\`, then a
   one-line verdict, the criteria as a checklist, and findings ordered by severity.
   Say plainly when something is a nit.

Don't post anything to GitHub unless the person asks you to in this conversation. The
review file is for them.`;

/**
 * GitHub. Its versioning service hosts the code; Issues and Projects come later as
 * separate services sharing this login.
 */

interface User {
  login: string;
}

interface Repository {
  full_name: string;
  description: string | null;
  archived: boolean;
}

async function validate(token: string): Promise<string> {
  return (await new GitHubApi(token).get<User>("/user")).login;
}

async function loginWithGh(context: PluginContext, account: string | undefined): Promise<{ account: string; credentials: Credentials }> {
  const accounts = ghAccounts();
  if (accounts.length === 0) {
    throw new DevError("gh isn't logged in to any GitHub account.", 'Run "gh auth login" first, or log in with a token: dev login github --method token.');
  }

  let user = account;
  if (user && !accounts.includes(user)) {
    throw new DevError(`gh has no login for ${user}. It has: ${accounts.join(", ")}.`, `Run "gh auth login" for ${user}, or pick another account.`);
  }
  if (!user) {
    if (accounts.length === 1) {
      user = accounts[0];
      context.out.info(`Using gh's only working account, ${user}. To use another, log it in with "gh auth login" first.`);
    } else {
      user = await choose("Which gh account?", accounts.map((name) => ({ value: name, name })), "--account <name>");
    }
  }

  const credentials: Credentials = { method: "gh", user: user ?? "" };
  return { account: await validate(tokenFor(credentials)), credentials };
}

async function loginWithToken(): Promise<{ account: string; credentials: Credentials }> {
  const token = (await secret("GitHub token (hidden as you type):", "a terminal")).trim();
  if (!token) throw new DevError("No token was entered.");
  return { account: await validate(token), credentials: { method: "token", token } };
}

const github: Plugin = {
  name: "github",
  title: "GitHub",
  description: "Code hosting, pull requests, issues and projects",

  login: {
    methods: [
      { kind: "cli", title: "Use a gh login (nothing secret is stored)" },
      { kind: "token", title: "Paste a personal access token" },
    ],
    async login(context, method, options) {
      return method === "cli" ? loginWithGh(context, options.account) : loginWithToken();
    },
    async check(_context, credentials) {
      try {
        return { ok: true, account: await validate(tokenFor(credentials)) };
      } catch (error) {
        const fix = error instanceof DevError ? error.fix : undefined;
        return { ok: false, problem: { message: (error as Error).message, fix: fix ?? 'Run "dev login github" again.' } };
      }
    },
  },

  secrets: (credentials) => (credentials.token ? [credentials.token] : []),
  commandPolicy: ghPolicy,

  services: [
    {
      id: "github",
      title: "GitHub",
      description: "Hosts the code repository",
      role: "versioning",
      scope: {
        describe: () => "the workspace's repository",
        choose: async () => ({}),
        validate: () => [],
      },
      versioning: {
        async listRepositories(_context: PluginContext, credentials: Credentials) {
          const api = GitHubApi.from(credentials);
          const repositories = await api.list<Repository>("/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member");
          return repositories
            .filter((repository) => !repository.archived)
            .map((repository) => ({ id: repository.full_name, description: repository.description ?? undefined }));
        },
        cloneUrl: (repository) => `${webBase()}/${repository}.git`,
        async clone(context, credentials, repository, target, url) {
          const source = url ?? `${webBase()}/${repository}.git`;
          context.out.info(`Cloning ${source} into ${path.basename(target)}/`);
          // Over SSH, git uses the person's own keys. Over HTTPS, this login's token.
          const token = source.startsWith("http") ? tokenFor(credentials) : undefined;
          return gitClone(source, target, token);
        },
      },
      index: { folder: FOLDER, title: "Pull requests under review", include: (file) => path.posix.basename(file) === DESCRIPTION },

      async sync(context) {
        return (await poll(context, { pull: true, includeDrafts: false, includeOwn: false })).report;
      },

      contribute: {
        async snapshot(context) {
          const prs = await waitingForReview(context);
          const open = prs.filter((pr) => !pr.reviewed);
          if (prs.length === 0) return null;
          return [
            "## Pull requests to review",
            "",
            open.length === 0
              ? "_All pulled PRs have a review._"
              : open.map((pr) => `- [#${pr.number}](${FOLDER}/${pr.number}/${DESCRIPTION}) ${pr.title} · ${pr.author}`).join("\n"),
          ].join("\n");
        },
        async sessionStart(context) {
          const open = (await waitingForReview(context)).filter((pr) => !pr.reviewed);
          return open.length === 0 ? [] : [`PRs waiting for review: ${open.map((pr) => `#${pr.number} ${pr.title}`).join("; ")}.`];
        },
      },

      commands: [
        {
          name: "prs",
          description: "Find the PRs that need review, and pull them into pull-requests/",
          mark: "read",
          options: [
            { flags: "--no-pull", description: "Only report; don't pull anything" },
            { flags: "--include-drafts", description: "Include draft PRs" },
            { flags: "--include-own", description: "Include your own PRs" },
            { flags: "--json", description: "Machine-readable output" },
          ],
          help: "Covers other people's PRs. Folders of PRs merged or closed since are removed. Only PRs that are new or changed are fetched.",
          async run(context, _args, options) {
            const result = await poll(context, {
              pull: options.pull !== false,
              includeDrafts: Boolean(options.includeDrafts),
              includeOwn: Boolean(options.includeOwn),
            });
            const attention = result.considered.filter((pr) => pr.state !== "current");
            if (options.json) {
              console.log(JSON.stringify({ repo: result.repo, open: result.open, needsReview: attention, removed: result.removed }, null, 2));
              return;
            }
            context.out.info(`${result.repo}: ${result.open} open, ${result.considered.length} to consider.`);
            for (const pr of result.considered) context.out.info(`  #${pr.number} [${pr.state}] ${pr.author}: ${pr.title}`);
            for (const pr of result.removed) context.out.info(`#${pr.number} was ${pr.state} since it was pulled. Its folder stays, marked ${pr.state}.`);
            for (const failure of result.report.failed) context.out.warn(`Couldn't pull ${failure.id}: ${failure.reason}`);
            if (options.pull === false && attention.length > 0) context.out.info('Not pulled, because of --no-pull. Pull one with "dev github pr <N>".');
            context.out.info(attention.length > 0 ? `Done: ${attention.length} to review: ${attention.map((pr) => `#${pr.number}`).join(", ")}.` : "Done: nothing to review.");
            if (result.report.failed.length > 0) process.exitCode = 1;
          },
        },
        {
          name: "pr",
          description: "Pull specific PRs into pull-requests/, with their comments and linked items",
          mark: "read",
          arguments: ["<numbers...>"],
          async run(context, args) {
            const repo = loadConfig(context.root).versioning?.repo ?? "";
            const api = GitHubApi.from(context.credentials());
            for (const raw of args) {
              const number = Number(raw);
              if (!Number.isInteger(number) || number < 1) throw new DevError(`"${raw}" isn't a PR number.`);
              const result = await pullRequest(context, api, repo, number);
              context.out.info(`#${number}: ${result.comments} comment${result.comments === 1 ? "" : "s"}${result.links.length > 0 ? `, linked ${result.links.join(", ")}` : ""}.`);
            }
            indexPulls(context);
          },
        },
      ],

      agentFiles: {
        skills: [{ name: "pr-review", description: "Find pull requests that need review and review someone else's PR, writing the result to its review file. Use when asked to review PRs, or when the session context lists PRs waiting.", body: REVIEW_SKILL }],
        rules: [
          "Use `gh` for reading pull requests and issues. Anything that changes GitHub needs the person's go-ahead in this conversation.",
        ],
      },
    },
  ],
};

export default github;
