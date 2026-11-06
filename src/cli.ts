#!/usr/bin/env node
import { CommanderError } from "commander";
import { consoleOutput, DevError } from "./core/output.ts";
import { loadRegistry } from "./plugins/registry.ts";
import { buildProgram } from "./program.ts";

try {
  const registry = await loadRegistry();
  const program = buildProgram({ registry, out: consoleOutput }).exitOverride();
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // Commander has already printed its message, or help.
    process.exitCode = error.exitCode;
  } else if (error instanceof DevError) {
    console.error(`Error: ${error.message}`);
    if (error.fix) console.error(`Fix: ${error.fix}`);
    process.exitCode = 1;
  } else {
    console.error(`Error: ${(error as Error).message ?? String(error)}`);
    if (process.env.DEV_DEBUG) console.error((error as Error).stack);
    process.exitCode = 1;
  }
}
