import path from "node:path";
import type { Credentials, Plugin, PluginContext } from "../types.ts";
import { DevError } from "../../core/output.ts";
import { choose, secret } from "../../core/prompt.ts";
import { gitClone } from "../../core/run.ts";
import { GitHubApi, ghAccounts, tokenFor, webBase } from "./api.ts";
import { ghPolicy } from "./policy.ts";

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
      agentFiles: {
        rules: [
          "Use `gh` for reading pull requests and issues. Anything that changes GitHub needs the person's go-ahead in this conversation.",
        ],
      },
    },
  ],
};

export default github;
