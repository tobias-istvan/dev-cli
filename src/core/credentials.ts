import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Credentials } from "../plugins/types.ts";
import { DevError } from "./output.ts";
import { configDir } from "./paths.ts";

/**
 * Credentials, one file per plugin, readable only by the owner, outside every workspace.
 *
 *   ~/.config/dev/credentials/<plugin>.json
 *   { "default": "<account>", "accounts": { "<account>": { ...values } } }
 *
 * Environment variables override stored values for the default account, for scripts:
 * DEV_<PLUGIN>_<KEY>, like DEV_ATLASSIAN_TOKEN. Names ending in _URL are settings, not credentials.
 */

interface CredentialFile {
  default?: string;
  accounts: Record<string, Credentials>;
}

const NAME = /^[a-z][a-z0-9-]*$/;

export function credentialsDir(): string {
  return path.join(configDir(), "credentials");
}

function fileFor(plugin: string): string {
  if (!NAME.test(plugin)) throw new Error(`Invalid plugin name: ${plugin}`);
  return path.join(credentialsDir(), `${plugin}.json`);
}

/** A warning when the file can be read by others. Never shows values. */
export function looseWarning(plugin: string): string | null {
  const file = fileFor(plugin);
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      return `${file} can be read by other users. Fix it with: chmod 600 ${file}`;
    }
  } catch {
    // No file yet.
  }
  return null;
}

function read(plugin: string): CredentialFile {
  const file = fileFor(plugin);
  if (!existsSync(file)) return { accounts: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CredentialFile>;
    return { default: parsed.default, accounts: parsed.accounts ?? {} };
  } catch {
    throw new DevError(
      `The saved login for ${plugin} can't be read.`,
      `Log in again with "dev login ${plugin}".`,
    );
  }
}

function write(plugin: string, data: CredentialFile): void {
  const dir = credentialsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  // Write beside it, then rename, so a crash never leaves half a file.
  const file = fileFor(plugin);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function fromEnvironment(plugin: string): Credentials {
  const prefix = `DEV_${plugin.toUpperCase().replace(/-/g, "_")}_`;
  const values: Credentials = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Settings like DEV_GITHUB_API_URL say where a service is, not who you are.
    if (key.startsWith(prefix) && value && !key.endsWith("_URL")) values[key.slice(prefix.length).toLowerCase()] = value;
  }
  return values;
}

/** The default account's credentials, with environment overrides. Null when there are none. */
export function loadCredentials(plugin: string): { account: string | null; credentials: Credentials } | null {
  const data = read(plugin);
  const account = data.default ?? null;
  const stored = account ? (data.accounts[account] ?? {}) : {};
  const credentials = { ...stored, ...fromEnvironment(plugin) };
  return Object.keys(credentials).length > 0 ? { account, credentials } : null;
}

/** Saves an account and makes it the default. */
export function saveCredentials(plugin: string, account: string, credentials: Credentials): void {
  const data = read(plugin);
  data.accounts[account] = credentials;
  data.default = account;
  write(plugin, data);
}

/** Removes one account, or all of them. Returns whether anything was removed. */
export function removeCredentials(plugin: string, account?: string): boolean {
  const data = read(plugin);
  if (!account) {
    const file = fileFor(plugin);
    const existed = existsSync(file);
    rmSync(file, { force: true });
    return existed;
  }

  if (!(account in data.accounts)) return false;
  delete data.accounts[account];
  if (data.default === account) data.default = Object.keys(data.accounts)[0];
  write(plugin, data);
  return true;
}

/** Account names only, never values. */
export function listAccounts(plugin: string): { default: string | null; accounts: string[] } {
  const data = read(plugin);
  return { default: data.default ?? null, accounts: Object.keys(data.accounts) };
}
