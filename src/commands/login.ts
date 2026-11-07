import type { Registry } from "../plugins/registry.ts";
import type { LoginMethod, Output, Plugin } from "../plugins/types.ts";
import { pluginContext } from "../core/context.ts";
import { listAccounts, loadCredentials, removeCredentials, saveCredentials } from "../core/credentials.ts";
import { DevError } from "../core/output.ts";
import { choose, confirm } from "../core/prompt.ts";
import { findWorkspaceRoot } from "../core/workspace.ts";

export interface LoginOptions {
  method?: string;
  account?: string;
}

export function findPlugin(registry: Registry, name: string): Plugin {
  const plugin = registry.plugin(name) ?? registry.service(name)?.plugin;
  if (!plugin) {
    const known = registry.plugins.map((p) => p.name).join(", ");
    throw new DevError(`There's no plugin called "${name}".`, `Use one of: ${known}.`);
  }
  return plugin;
}

/** Logs in to a plugin and saves the result. People only: it refuses without a terminal. */
export async function login(plugin: Plugin, out: Output, options: LoginOptions): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new DevError(
      `Logging in to ${plugin.title} needs a person at a terminal, so it doesn't run for agents or scripts.`,
      `Run "dev login ${plugin.name}" yourself. Scripts can set DEV_${plugin.name.toUpperCase()}_TOKEN instead.`,
    );
  }

  const methods = plugin.login.methods;
  let method: LoginMethod["kind"] | undefined;
  if (options.method) {
    method = methods.find((m) => m.kind === options.method)?.kind;
    if (!method) throw new DevError(`${plugin.title} has no "${options.method}" login.`, `Use one of: ${methods.map((m) => m.kind).join(", ")}.`);
  } else if (methods.length === 1) {
    method = methods[0]?.kind;
  } else {
    method = await choose(`How do you want to log in to ${plugin.title}?`, methods.map((m) => ({ value: m.kind, name: m.title })), "--method");
  }

  const result = await plugin.login.login(pluginContext(findWorkspaceRoot(), out), method ?? "token", { account: options.account });
  saveCredentials(plugin.name, result.account, result.credentials);
  out.info(`Logged in to ${plugin.title} as ${result.account}. Saved for this machine only, outside every workspace.`);
  return result.account;
}

/** Logs in only when there's no saved login yet. */
export async function ensureLogin(plugin: Plugin, out: Output, options: LoginOptions = {}): Promise<void> {
  const saved = loadCredentials(plugin.name);
  if (saved) {
    out.info(`${plugin.title}: using the saved login${saved.account ? ` for ${saved.account}` : ""}.`);
    return;
  }
  const optional = plugin.login.optional;
  if (optional) {
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (!interactive || !(await confirm(`Log in to ${plugin.title}? It's optional: ${optional.benefit}`, "a terminal", false))) {
      out.info(`${plugin.title}: skipped the login. With one, ${optional.benefit}. Log in any time with "dev login ${plugin.name}".`);
      return;
    }
  }
  await login(plugin, out, options);
}

export async function runLogin(registry: Registry, out: Output, name: string, options: LoginOptions): Promise<void> {
  await login(findPlugin(registry, name), out, options);
}

export async function runLogout(registry: Registry, out: Output, name: string, options: { account?: string }): Promise<void> {
  const plugin = findPlugin(registry, name);
  const saved = loadCredentials(plugin.name);

  if (saved && plugin.login.logout) {
    try {
      await plugin.login.logout(pluginContext(findWorkspaceRoot(), out), saved.credentials);
    } catch (error) {
      out.warn(`Couldn't sign out on ${plugin.title}'s side: ${(error as Error).message}. Removing the saved login anyway.`);
    }
  }

  const accounts = listAccounts(plugin.name).accounts;
  if (!removeCredentials(plugin.name, options.account)) {
    out.info(`There was no saved ${plugin.title} login${options.account ? ` for ${options.account}` : ""}.`);
    return;
  }
  out.info(`Removed the saved ${plugin.title} login${options.account ? ` for ${options.account}` : accounts.length > 1 ? "s" : ""}.`);
}
