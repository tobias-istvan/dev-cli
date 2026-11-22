import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Registry } from "../plugins/registry.ts";
import type { Output } from "../plugins/types.ts";
import { classifiers, judge, judgeFileEdit, loadPolicy, type Verdict } from "../core/command-check.ts";
import { workspaceServiceContext } from "../core/context.ts";
import { latestHandoff, today } from "../core/day.ts";
import { parseConfig, configPath } from "../core/project-config.ts";
import { enabledServices } from "../core/scaffold.ts";
import { parseHookInput, readStdin, recordSession, saveSession } from "../core/sessions/index.ts";
import { readRecord, recordIds, reopenAdvice } from "../core/task-record.ts";
import { worktreeIds } from "../core/worktree.ts";
import { describeRefresh, refreshState } from "../core/refresh.ts";
import { findWorkspaceRoot } from "../core/workspace.ts";

/**
 * What Copilot CLI and Claude Code run at session start, session end, and before each
 * shell command. Hooks must never fail or hang: a failing hook could block a session.
 */

const STALE_MS = 4 * 60 * 60 * 1000;
const silent: Output = { info() {}, warn() {} };

function workspaceFor(cwd: string | null): string | null {
  return findWorkspaceRoot(cwd ?? process.cwd()) ?? findWorkspaceRoot();
}

async function snapshotIsStale(root: string): Promise<boolean> {
  const file = path.join(root, "snapshot.md");
  if (!existsSync(file)) return true;
  if (!(await readFile(file, "utf8")).startsWith(`# Snapshot · ${today()}`)) return true;
  return Date.now() - (await stat(file)).mtimeMs > STALE_MS;
}

/** Starts `dev day start` in the background. Its output goes to a gitignored log. */
function refreshInBackground(root: string): void {
  mkdirSync(path.join(root, ".dev", "state"), { recursive: true });
  const log = openSync(path.join(root, ".dev", "state", "day-start.log"), "a");
  const script = process.argv[1] ?? "";
  spawn(process.execPath, [...process.execArgv, script, "day", "start"], { cwd: root, detached: true, stdio: ["ignore", log, log] }).unref();
}

function respond(tool: string, event: string, fields: Record<string, unknown>): void {
  if (Object.keys(fields).length === 0) {
    console.log("{}");
    return;
  }
  const nested = { hookEventName: event, ...fields };
  // Copilot CLI reads the top-level fields; Claude Code and VS Code read the nested ones.
  console.log(JSON.stringify(tool === "claude" ? { hookSpecificOutput: nested } : { ...fields, hookSpecificOutput: nested }));
}

export async function runSessionStart(registry: Registry, toolOption: string): Promise<void> {
  const input = parseHookInput(await readStdin(), toolOption);
  const root = workspaceFor(input.cwd);
  if (input.standDown || !root) return respond(input.tool, "SessionStart", {});

  await recordSession(root, input, "start").catch(() => {});

  const lines = ["dev workspace. Read AGENTS.md before acting."];
  const handoff = await latestHandoff(root).catch(() => null);
  if (handoff) {
    lines.push("", `Carried over from ${handoff.date}, next steps:`, handoff.nextSteps);
    if (handoff.blocked) lines.push("", "Still blocked:", handoff.blocked);
  }

  const tasks = await worktreeIds(root);
  if (tasks.length > 0) {
    lines.push("", `Tasks in flight: ${tasks.join(", ")}. Each has its record in tasks/<id>/; \`dev task status <id>\` sums it up.`);
    // Only what needs action now.
    for (const id of tasks) {
      try {
        const record = await readRecord(root, id);
        const fresh = record.logs.changes.byStatus.new ?? [];
        const needs = [
          ...(fresh.length > 0 ? [`${fresh.length} source change${fresh.length === 1 ? "" : "s"} to review (${fresh.join(", ")}), with task-changes`] : []),
          ...(record.blocking.length > 0 ? [`${record.blocking.length} blocking finding${record.blocking.length === 1 ? "" : "s"} (${record.blocking.join(", ")})`] : []),
        ];
        if (needs.length > 0) lines.push(`${id}: ${needs.join(", ")}.`);
      } catch {
        // An unreadable record is left out, never allowed to block the session.
      }
    }
  }

  // A reopened ticket needs action whether or not its task is in flight.
  const reopened: string[] = [];
  for (const id of await recordIds(root)) {
    const record = await readRecord(root, id).catch(() => null);
    if (record && record.reopened.length > 0) reopened.push(`${id} (${record.reopened.join(", ")}): ${reopenAdvice(record)}`);
  }
  if (reopened.length > 0) lines.push("", `Tickets reopened: ${reopened.join("; ")}.`);

  const { config, problems } = parseConfig(await readFile(configPath(root), "utf8"));
  if (problems.length === 0) {
    for (const entry of enabledServices(config, registry)) {
      try {
        const extra = await entry.service.contribute?.sessionStart?.(workspaceServiceContext(root, entry, config, registry, silent));
        if (extra && extra.length > 0) lines.push("", ...extra);
      } catch {
        // A service that can't answer quickly is left out, never allowed to block the session.
      }
    }
    const state = refreshState(root);
    if (state.running) {
      lines.push("", `A sync is running: ${describeRefresh(state.refresh)}. Run \`dev day status\` to see when it's done, then re-read what it updates.`);
    } else if (await snapshotIsStale(root)) {
      refreshInBackground(root);
      lines.push("", "snapshot.md was out of date, so `dev day start` is refreshing it in the background. Run `dev day status` to see when it's done, then re-read snapshot.md.");
    }
  }

  respond(input.tool, "SessionStart", { additionalContext: lines.join("\n").trim() });
}

export async function runSessionEnd(registry: Registry, toolOption: string): Promise<void> {
  const input = parseHookInput(await readStdin(), toolOption);
  const root = workspaceFor(input.cwd);
  if (input.standDown || !root) return;

  const folder = await recordSession(root, input, "end").catch(() => null);
  if (!folder) return;
  try {
    const reference = JSON.parse(await readFile(path.join(folder, "session-ref.json"), "utf8"));
    if (await saveSession(root, folder, reference, registry)) console.log(`Saved ${path.relative(root, folder)}/session.md`);
  } catch (error) {
    console.log(`Couldn't save the session: ${(error as Error).message}`);
  }
}

/** The shell command in a pre-tool payload, whichever tool sent it. */
export function commandFrom(raw: Record<string, unknown>): string | null {
  let args: unknown = raw.tool_input ?? raw.toolInput ?? raw.toolArgs ?? raw.tool_args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object") return null;
  const fields = args as Record<string, unknown>;
  const command = fields.command ?? fields.cmd;
  return typeof command === "string" && command.trim() ? command : null;
}

export function check(registry: Registry, command: string, root: string | null = findWorkspaceRoot(), cwd: string | null = process.cwd()): Verdict {
  return judge(command, loadPolicy().policy, classifiers(registry), root, cwd);
}

/** The file a file-editing tool is about to write, if this payload is one. Reading tools don't count. */
export function editedFile(raw: Record<string, unknown>): string | null {
  const name = String(raw.tool_name ?? raw.toolName ?? "");
  if (/read|view|glob|grep|search|list|fetch/i.test(name)) return null;
  let args: unknown = raw.tool_input ?? raw.toolInput ?? raw.toolArgs ?? raw.tool_args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object") return null;
  const fields = args as Record<string, unknown>;
  const file = fields.file_path ?? fields.filePath ?? fields.path ?? fields.notebook_path;
  return typeof file === "string" && file ? file : null;
}

export async function runPreTool(registry: Registry, toolOption: string): Promise<void> {
  const input = parseHookInput(await readStdin(), toolOption);
  if (input.standDown) return respond(input.tool, "PreToolUse", {});
  const root = workspaceFor(input.cwd);
  const command = commandFrom(input.raw);

  let verdict: Verdict | null;
  try {
    if (command) {
      verdict = check(registry, command, root, input.cwd ?? root);
    } else {
      const file = editedFile(input.raw);
      const absolute = file && input.cwd && !path.isAbsolute(file) ? path.join(input.cwd, file) : file;
      verdict = absolute ? judgeFileEdit(absolute, loadPolicy().policy, root) : null;
    }
    if (!verdict) return respond(input.tool, "PreToolUse", {});
  } catch {
    verdict = { decision: "ask", calls: [], reason: "dev command check: the check failed, so this needs the person's approval" };
  }
  if (!verdict.decision) return respond(input.tool, "PreToolUse", {});
  respond(input.tool, "PreToolUse", { permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason });
}

export function runCheck(registry: Registry, out: Output, words: string[]): void {
  const verdict = check(registry, words.join(" "));
  const { problem } = loadPolicy();
  if (verdict.calls.length === 0) {
    out.info("No command the check knows, so it has no opinion. Your tool's own permissions apply.");
  } else {
    out.info(`Decision: ${verdict.decision ?? "no opinion (the line also runs other things, or writes a file, so your tool's own permissions apply)"}`);
    for (const call of verdict.calls) out.info(`  ${call.command}: ${call.why}. Rule ${call.rule}`);
  }
  if (problem) out.info(`Policy: defaults, because ${problem}`);
}
