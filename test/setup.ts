import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
for (const key of Object.keys(process.env)) if (key.startsWith("DEV_")) delete process.env[key];
const config = mkdtempSync(path.join(tmpdir(), "dev-tests-config-"));
process.env.XDG_CONFIG_HOME = config;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";
process.on("exit", () => rmSync(config, { recursive: true, force: true }));

process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --experimental-strip-types`.trim();
