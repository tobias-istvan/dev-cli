import path from "node:path";
import type { Credentials, Plugin } from "../types.ts";
import { DevError } from "../../core/output.ts";
import { ask, secret } from "../../core/prompt.ts";
import { gitClone } from "../../core/run.ts";
import { GitLabApi, serverFrom } from "./api.ts";
import { gitlabIssues } from "./issues.ts";
import { changeRequests, DESCRIPTION, FOLDER, INDEX as MERGES_INDEX, indexMerges, pollMerges, pullMerge, waitingForReview } from "./merges.ts";
import { glabPolicy } from "./policy.ts";
import { loadConfig } from "../../core/project-config.ts";
import { reviewWorktree } from "../../core/worktree.ts";

/** GitLab, on gitlab.com or a self-hosted server: code hosting, merge requests and issues. */

const REVIEW_SKILL = `# Reviewing a merge request

Review other people's merge requests only, never your own.

1. Run \`dev gitlab mrs\`. It lists the open merge requests that need review and pulls each
   into \`merge-requests/<N>/\`: \`mr-description.md\`, \`comments.md\`, and any linked tickets or
   specs from other services.
2. Read \`mr-description.md\`, then the linked items. Read the diff with \`glab mr diff <N>\`.
   To run the code, or open it in an editor, run \`dev gitlab mr <N> --worktree\`: it checks
   the MR out in \`worktrees/mr-<N>\` on its own branch. Never check out a detached commit.
3. Check, in this order: does it do what the linked ticket asks; regression risk; the
   repository's own standards in \`repository/AGENTS.md\`; consistency with the code around it.
4. Write \`merge-requests/<N>/review.md\`, starting with \`# MR !<N>: <title>\`, then a one-line
   verdict, the criteria as a checklist, and findings ordered by severity.

Don't post anything to GitLab unless the person asks you to in this conversation.`;

function normaliseHost(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(url).origin;
  } catch {
    throw new DevError(`"${value}" isn't a server address.`, "Use one like https://gitlab.com or https://gitlab.example.com.");
  }
}

async function whoAmI(credentials: Credentials): Promise<string> {
  return (await GitLabApi.from(credentials).get<{ username: string }>("/user")).username;
}

const gitlab: Plugin = {
  name: "gitlab",
  title: "GitLab",
  description: "Code hosting, merge requests and issues, on gitlab.com or your own server",

  login: {
    methods: [{ kind: "token", title: "Server address and personal access token" }],
    async login(context) {
      const host = normaliseHost(await ask("GitLab server:", "a terminal", "https://gitlab.com"));
      context.out.info(`Create a token at ${host}/-/user_settings/personal_access_tokens with the read_api scope.`);
      const token = (await secret("Personal access token (hidden as you type):", "a terminal")).trim();
      if (!token) throw new DevError("No token was entered.");
      const credentials: Credentials = { host, token };
      const user = await whoAmI(credentials);
      return { account: `${user} on ${new URL(host).host}`, credentials };
    },
    async check(_context, credentials) {
      try {
        return { ok: true, account: await whoAmI(credentials) };
      } catch (error) {
        return { ok: false, problem: { message: (error as Error).message, fix: (error as DevError).fix ?? 'Run "dev login gitlab" again.' } };
      }
    },
  },

  secrets: (credentials) => (credentials.token ? [credentials.token] : []),
  commandPolicy: glabPolicy,

  services: [
    {
      id: "gitlab",
      title: "GitLab",
      description: "Hosts the code repository",
      role: "versioning",
      scope: { describe: () => "the workspace's project", choose: async () => ({}), validate: () => [] },
      versioning: {
        async listRepositories(_context, credentials) {
          const projects = await GitLabApi.from(credentials).list<{ path_with_namespace: string; description: string | null; archived: boolean }>(
            "/projects?membership=true&simple=true&order_by=last_activity_at&archived=false",
          );
          return projects.filter((p) => !p.archived).map((p) => ({ id: p.path_with_namespace, description: p.description ?? undefined }));
        },
        cloneUrl: (repository) => `https://gitlab.com/${repository}.git`,
        async clone(context, credentials, repository, target, url) {
          const server = serverFrom(credentials);
          const source = url ?? `${server.host}/${repository}.git`;
          context.out.info(`Cloning ${source} into ${path.basename(target)}/`);
          // Over SSH, git uses the person's own keys. Over HTTPS, this login's token, for this clone only.
          return gitClone(source, target, source.startsWith("https:") && new URL(source).origin === new URL(server.host).origin ? server.token : undefined, "oauth2");
        },
        changeRequests: (_context, credentials, repository, branch) => changeRequests(GitLabApi.from(credentials), repository, branch),
      },
      index: MERGES_INDEX,
      async sync(context) {
        return (await pollMerges(context, { pull: true, includeDrafts: false, includeOwn: false })).report;
      },
      contribute: {
        async snapshot(context) {
          const waiting = await waitingForReview(context);
          if (waiting.length === 0) return null;
          return ["## Merge requests to review", "", ...waiting.map((mr) => `- [!${mr.number}](${FOLDER}/${mr.number}/${DESCRIPTION}) ${mr.title} · ${mr.author}`)].join("\n");
        },
        async sessionStart(context) {
          const waiting = await waitingForReview(context);
          return waiting.length === 0 ? [] : [`Merge requests waiting for review: ${waiting.map((mr) => `!${mr.number} ${mr.title}`).join("; ")}.`];
        },
      },
      commands: [
        {
          name: "mrs",
          description: "Find the merge requests that need review, and pull them into merge-requests/",
          mark: "read",
          writes: (options) => options.pull !== false,
          options: [
            { flags: "--no-pull", description: "Only report; don't pull anything" },
            { flags: "--include-drafts", description: "Include drafts" },
            { flags: "--include-own", description: "Include your own" },
          ],
          async run(context, _args, options) {
            const result = await pollMerges(context, { pull: options.pull !== false, includeDrafts: Boolean(options.includeDrafts), includeOwn: Boolean(options.includeOwn) });
            const attention = result.considered.filter((mr) => mr.state !== "current");
            context.out.info(`${result.repo}: ${result.open} open, ${result.considered.length} to consider.`);
            for (const mr of result.considered) context.out.info(`  !${mr.number} [${mr.state}] ${mr.author}: ${mr.title}`);
            for (const mr of result.finished) context.out.info(`!${mr.number} was ${mr.state} since it was pulled. Its folder stays, marked ${mr.state}.`);
            for (const failure of result.report.failed) context.out.warn(`Couldn't pull ${failure.id}: ${failure.reason}`);
            context.out.info(attention.length > 0 ? `Done: ${attention.length} to review: ${attention.map((mr) => `!${mr.number}`).join(", ")}.` : "Done: nothing to review.");
            if (result.report.failed.length > 0) process.exitCode = 1;
          },
        },
        {
          name: "mr",
          description: "Pull specific merge requests, with their comments and linked items",
          mark: "read",
          writes: true,
          arguments: ["<numbers...>"],
          options: [{ flags: "--worktree", description: "Also check each out in worktrees/mr-<N>, on the MR's own branch" }],
          help: "With --worktree, the MR's branch is checked out, tracking it on origin, never as a detached commit. Open it in an editor from worktrees/mr-<N>.",
          async run(context, args, options) {
            const repo = loadConfig(context.root).versioning?.repo ?? "";
            const api = GitLabApi.from(context.credentials());
            for (const raw of args) {
              const iid = Number(raw.replace("!", ""));
              if (!Number.isInteger(iid) || iid < 1) throw new DevError(`"${raw}" isn't a merge request number.`);
              const result = await pullMerge(context, api, repo, iid);
              context.out.info(`!${iid}: ${result.comments} comment${result.comments === 1 ? "" : "s"}${result.links.length > 0 ? `, linked ${result.links.join(", ")}` : ""}.`);
              if (options.worktree) {
                const tree = await reviewWorktree(context.root, `mr-${iid}`, result.fork ? { forkRef: `refs/merge-requests/${iid}/head` } : { branch: result.head });
                context.out.info(`  Worktree: worktrees/mr-${iid} on ${tree.branch}${tree.existed ? ", already there" : ""}. Open it with: code worktrees/mr-${iid}`);
              }
            }
            indexMerges(context);
          },
        },
      ],
      agentFiles: {
        skills: [{ name: "mr-review", description: "Find merge requests that need review and review someone else's, writing the result to its review file. Use when asked to review MRs.", body: REVIEW_SKILL }],
        rules: [
          "Use glab for reading merge requests and issues. Anything that changes GitLab needs the person's go-ahead in this conversation.",
          "To open an MR's code, in an editor or to run it, use `dev gitlab mr <N> --worktree`. It checks the MR's own branch out in worktrees/mr-<N>. Never check out a detached commit for an MR.",
        ],
      },
    },
    gitlabIssues,
  ],
};

export default gitlab;
