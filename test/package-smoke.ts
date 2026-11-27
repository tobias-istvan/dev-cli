import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --experimental-strip-types`.trim();
const root = path.resolve(import.meta.dirname, "..");
const temp = mkdtempSync(path.join(tmpdir(), "dev-package-"));
const npm = (args: string[], cwd = root) => execFileSync("npm", args, { cwd, encoding: "utf8", timeout: 120_000 });
try {
  const packed = npm(["pack", "--cache", path.join(temp, "cache"), "--json", "--pack-destination", temp]);
  const name = JSON.parse(packed)[0].filename;
  npm(["install", "--cache", path.join(temp, "cache"), "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", path.join(temp, "installed"), path.join(temp, name)]);
  const installed = path.join(temp, "installed", "node_modules", "@tobias.istvan", "dev");
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  assert.equal(execFileSync(process.execPath, [path.join(installed, "dist/cli.js"), "--version"], { encoding: "utf8" }).trim(), version);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(temp, "config"), DEV_EXTRA_PLUGINS: path.join(root, "test/fixtures/example-plugin.ts"), DEV_EXAMPLE_TOKEN: "good" };
  const workspace = path.join(temp, "workspace");
  execFileSync(process.execPath, [path.join(installed, "dist/cli.js"), "init", workspace, "--versioning", "example:code", "--repo", "acme/web", "--no-clone"], { env, timeout: 30_000 });
  assert.match(readFileSync(path.join(workspace, "AGENTS.md"), "utf8"), /acme\/web/);
  assert.match(readFileSync(path.join(workspace, "INSTRUCTIONS.md"), "utf8"), /^# Instructions/);
  assert.ok(JSON.parse(readFileSync(path.join(workspace, ".claude/settings.json"), "utf8")).hooks.PreToolUse);
  console.log("Packed CLI installation, version, init, templates and hook generation passed.");
} finally { rmSync(temp, { recursive: true, force: true }); }
