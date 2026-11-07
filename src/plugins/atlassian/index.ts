import type { Credentials, Plugin } from "../types.ts";
import { DevError } from "../../core/output.ts";
import { ask, secret } from "../../core/prompt.ts";
import { AtlassianClient, siteFrom } from "./client.ts";
import { confluence } from "./confluence.ts";
import { jira } from "./jira.ts";

/** Atlassian Cloud: Jira and Confluence, sharing one site login. */

function normaliseSite(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "").replace(/\/wiki$/, "");
  const url = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(url).origin;
  } catch {
    throw new DevError(`"${value}" isn't a site address.`, "Use one like https://example.atlassian.net.");
  }
}

async function whoAmI(credentials: Credentials): Promise<string> {
  const me = await new AtlassianClient(siteFrom(credentials)).get<{ emailAddress?: string; displayName?: string }>("/rest/api/3/myself");
  return me.emailAddress ?? me.displayName ?? credentials.email ?? "unknown";
}

const atlassian: Plugin = {
  name: "atlassian",
  title: "Atlassian",
  description: "Jira and Confluence on one Atlassian Cloud site",

  login: {
    methods: [{ kind: "token", title: "Site, email and API token" }],
    async login(context) {
      context.out.info("Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens");
      const site = normaliseSite(await ask("Site address, like https://example.atlassian.net:", "a terminal"));
      const email = (await ask("Your Atlassian email:", "a terminal")).trim();
      const token = (await secret("API token (hidden as you type):", "a terminal")).trim();
      const credentials: Credentials = { site, email, token };
      await whoAmI(credentials);
      return { account: `${email} on ${new URL(site).host}`, credentials };
    },
    async check(_context, credentials) {
      try {
        return { ok: true, account: await whoAmI(credentials) };
      } catch (error) {
        return { ok: false, problem: { message: (error as Error).message, fix: (error as DevError).fix ?? 'Run "dev login atlassian" again.' } };
      }
    },
  },

  secrets: (credentials) => (credentials.token ? [credentials.token] : []),
  services: [jira, confluence],
};

export default atlassian;
