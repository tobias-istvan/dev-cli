import { createHash } from "node:crypto";
import { safePath, atomicWrite } from "../files.ts";
import { configDir } from "../paths.ts";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Output } from "../../plugins/types.ts";
import type { Registry } from "../../plugins/registry.ts";
import { credentialSets } from "../credentials.ts";
import type { SessionLine } from "../day.ts";
import { renderSession, type RenderOptions } from "./render.ts";

/**
 * Saving agent sessions into work-sessions/<date>/<HH-MM>-<id8>/.
 *
 * Hooks write session-ref.json when a session starts and ends: the tool, the session id
 * and times, never transcript content or a path under someone's home, since the folder is
 * committed. The transcript is found on this machine from that, rendered as Markdown with
 * secrets redacted, and saved as session.md.
 */

export type Tool = "claude" | "copilot" | "vscode";

export interface SessionReference {
  version: 1;
  tool: Tool;
  sessionId: string;
  started: string;
  ended: string | null;
  endReason: string | null;
  task: string | null;
  /** Where it ran, relative to the workspace: "." or worktrees/<id>. */
  workingDir: string;
}

export interface HookInput {
  tool: Tool;
  sessionId: string | null;
  cwd: string | null;
  reason: string | null;
  /** Another hook file handles this tool, so this run does nothing. */
  standDown: boolean;
  raw: Record<string, unknown>;
}

const REFERENCE = "session-ref.json";
const WORKTREE = /(?:^|\/)worktrees\/([^/]+)(?:\/|$)/;

export const DEFAULT_RENDER: RenderOptions = { thinking: false, sidechains: false, maxOutputLines: 40 };

// ---------------------------------------------------------------------------
// Hook input

/**
 * Hooks send JSON on stdin, with field names that differ by tool. Copilot CLI and VS Code
 * also run the hooks in .claude/settings.json; they have their own hook file, so that run
 * stands down. Copilot CLI's run of it looks like Claude Code's, down to
 * CLAUDE_PROJECT_DIR, except that Claude Code sends no timestamp.
 */
export function parseHookInput(raw: string, toolOption: string): HookInput {
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
  } catch {
    // Run by hand, or by a tool that sends nothing.
  }
  const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  const fromOption: Tool = toolOption === "copilot" ? "copilot" : "claude";
  const tool: Tool =
    "sessionId" in input ? "copilot" : "session_id" in input ? (process.env.CLAUDE_PROJECT_DIR && !("timestamp" in input) ? "claude" : "vscode") : fromOption;

  return {
    tool,
    standDown: fromOption === "claude" && tool !== "claude",
    sessionId: text(input.sessionId) ?? text(input.session_id),
    cwd: text(input.cwd),
    reason: text(input.reason),
    raw: input,
  };
}

/** Everything on stdin. A hook must never hang, so an open pipe only gets a moment. */
export function readStdin(limitMs = 1000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const finish = (): void => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(finish, limitMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

// ---------------------------------------------------------------------------
// References

function sessionsDir(root: string): string {
  return path.join(root, "work-sessions");
}

function folderFor(root: string, started: string, sessionId: string): string {
  const time = new Date(started).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }).replace(":", "-");
  return path.join(sessionsDir(root), new Date(started).toLocaleDateString("en-CA"), `${time}-${sessionId}`);
}

/** A session keeps one folder, even when it's resumed on a later day. */
async function findFolder(root: string, sessionId: string): Promise<string | null> {
  if (!existsSync(sessionsDir(root))) return null;
  const suffix = `-${sessionId.slice(0, 8)}`;
  for (const date of await readdir(sessionsDir(root), { withFileTypes: true })) {
    if (!date.isDirectory()) continue;
    for (const name of await readdir(path.join(sessionsDir(root), date.name))) {
      if (name.endsWith(suffix) || name.endsWith(`-${sessionId}`)) {
        const candidate = path.join(sessionsDir(root), date.name, name);
        if ((await readReference(candidate))?.sessionId === sessionId) return candidate;
      }
    }
  }
  return null;
}

async function readReference(folder: string): Promise<SessionReference | null> {
  try {
    const value = JSON.parse(await readFile(path.join(folder, REFERENCE), "utf8"));
    return validReference(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeReference(folder: string, reference: SessionReference): Promise<void> {
  await mkdir(folder, { recursive: true });
  await atomicWrite(path.join(folder, REFERENCE), `${JSON.stringify(reference, null, 2)}\n`);
}

function workingDirOf(root: string, cwd: string | null): string {
  const relative = path.relative(root, cwd ?? process.cwd()).split(path.sep).join("/");
  const id = relative.match(WORKTREE)?.[1];
  return id ? `worktrees/${id}` : ".";
}

export async function recordSession(root: string, input: HookInput, event: "start" | "end"): Promise<string | null> {
  if (!input.sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId)) return null;
  const now = new Date().toISOString();
  const folder = (await findFolder(root, input.sessionId)) ?? folderFor(root, now, input.sessionId);
  const existing = await readReference(folder);
  // Where the session started, since a later hook can fire from another folder, and the
  // transcript is filed under the first. This machine's own record is believed first.
  const workingDir = readProvenance(root, { tool: input.tool, sessionId: input.sessionId })?.workingDir ?? existing?.workingDir ?? workingDirOf(root, input.cwd);
  safePath(root, path.relative(root, path.join(folder, REFERENCE)));
  if (workingDir !== ".") safePath(root, workingDir);

  const reference: SessionReference = {
    version: 1,
    tool: input.tool,
    sessionId: input.sessionId,
    started: existing?.started ?? now,
    ended: event === "end" ? now : null,
    endReason: event === "end" ? input.reason : null,
    task: existing?.task ?? workingDir.match(WORKTREE)?.[1] ?? null,
    workingDir,
  };
  await writeReference(folder, reference);
  await atomicWrite(provenanceFile(root, reference), JSON.stringify({ tool: reference.tool, sessionId: reference.sessionId, workingDir: reference.workingDir }));
  return folder;
}

async function listReferences(root: string): Promise<Array<{ folder: string; reference: SessionReference }>> {
  if (!existsSync(sessionsDir(root))) return [];
  const found: Array<{ folder: string; reference: SessionReference }> = [];
  for (const date of await readdir(sessionsDir(root), { withFileTypes: true })) {
    if (!date.isDirectory()) continue;
    for (const name of await readdir(path.join(sessionsDir(root), date.name))) {
      const folder = path.join(sessionsDir(root), date.name, name);
      const reference = await readReference(folder);
      if (reference) found.push({ folder, reference });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Transcripts on this machine

/** Claude Code keeps one transcript per session, under a folder named after the project path. */
export function claudeDir(projectPath: string): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "projects", projectPath.replace(/[^a-zA-Z0-9]/g, "-"));
}

function copilotFile(sessionId: string): string {
  return path.join(process.env.COPILOT_HOME ?? path.join(homedir(), ".copilot"), "session-state", sessionId, "events.jsonl");
}

function locate(root: string, reference: SessionReference): string | null {
  if (!validReference(reference) || reference.tool === "vscode") return null;
  // A reference from before provenance was recorded has none. A workspace is one person's
  // for now, so it is this machine's own; team support has to require the record.
  const trusted = readProvenance(root, reference);
  if (trusted && trusted.workingDir !== reference.workingDir) return null;
  const file =
    reference.tool === "copilot" ? copilotFile(reference.sessionId) : path.join(claudeDir(path.join(root, reference.workingDir)), `${reference.sessionId}.jsonl`);
  return existsSync(file) ? file : null;
}

function parseLines(contents: string): Array<Record<string, any>> {
  return contents.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, any>];
    } catch {
      return []; // A transcript being written to can end mid-line.
    }
  });
}

/** Copilot's events, in the entry shape the renderer reads. Only the conversation and tool calls. */
function copilotEntries(events: Array<Record<string, any>>, sessionId: string): Array<Record<string, unknown>> {
  const start = events.find((event) => event.type === "session.start");
  const context = start?.data?.context ?? {};
  const common = { sessionId: String(start?.data?.sessionId ?? sessionId), cwd: String(context.cwd ?? ""), gitBranch: String(context.branch ?? "") };

  return events.flatMap((event): Array<Record<string, unknown>> => {
    // Only agentId marks a subagent. parentAgentTaskId is on top-level messages too.
    const base = { ...common, timestamp: event.timestamp, isSidechain: Boolean(event.agentId) };
    if (event.type === "user.message") return [{ ...base, type: "user", message: { role: "user", content: String(event.data?.content ?? "") } }];
    if (event.type === "assistant.message") {
      const text = String(event.data?.content ?? "");
      const tools = Array.isArray(event.data?.toolRequests) ? event.data.toolRequests : [];
      return [{ ...base, type: "assistant", message: { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...tools.map((t: any) => ({ type: "tool_use", name: t?.name, input: t?.arguments }))] } }];
    }
    if (event.type === "tool.execution_complete" && typeof event.data?.result?.content === "string") {
      return [{ ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", content: event.data.result.content, is_error: event.data?.success === false }] } }];
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// Redaction

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bATATT[A-Za-z0-9_\-=]{20,}/g, "[REDACTED:atlassian-token]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED:gitlab-token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]"],
  [/\bfigd_[A-Za-z0-9_-]{20,}/g, "[REDACTED:figma-token]"],
  [/\bntn_[A-Za-z0-9]{20,}/g, "[REDACTED:notion-token]"],
];

/** Each plugin's secrets, found by exact match however they were printed, plus common token shapes. */
export function createRedactor(registry: Registry): (text: string) => string {
  const literals = new Set<string>();
  for (const plugin of registry.plugins) {
    if (!plugin.secrets) continue;
    for (const values of credentialSets(plugin.name)) {
      for (const secret of plugin.secrets(values)) if (secret.length >= 8) {
        literals.add(secret);
        literals.add(encodeURIComponent(secret));
      }
      if (values.email && values.token) literals.add(Buffer.from(`${values.email}:${values.token}`).toString("base64"));
    }
  }
  const literal = literals.size > 0 ? new RegExp([...literals].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;

  return (text) => {
    let result = literal ? text.replace(literal, "[REDACTED]") : text;
    for (const [pattern, replacement] of TOKEN_PATTERNS) result = result.replace(pattern, replacement);
    return result;
  };
}

// ---------------------------------------------------------------------------
// Saving

/** Saves one session's transcript. Returns false when it isn't on this machine or has no conversation yet. */
export async function saveSession(root: string, folder: string, reference: SessionReference, registry: Registry): Promise<boolean> {
  safePath(root, path.relative(root, path.join(folder, "session.md")));
  const file = locate(root, reference);
  if (!file) return false;
  const lines = parseLines(await readFile(file, "utf8"));
  const entries = reference.tool === "copilot" ? copilotEntries(lines, reference.sessionId) : lines;
  const { markdown, meta } = renderSession(entries as any[], DEFAULT_RENDER, reference.tool === "copilot" ? "copilot" : "claude", createRedactor(registry));
  if (!meta.date) return false;
  await atomicWrite(path.join(folder, "session.md"), markdown);
  return true;
}

/**
 * Saves every session with a reference whose transcript is on this machine and isn't saved
 * in full yet: no session.md, or no recorded end, so it may have been killed. Then lists
 * the sessions of `date` for the day summary.
 */
export async function saveSessions(root: string, registry: Registry, out: Output, date: string): Promise<SessionLine[]> {
  const references = await listReferences(root);
  let vscode = false;

  for (const { folder, reference } of references) {
    if (reference.tool === "vscode") {
      vscode ||= !existsSync(path.join(folder, "session.md"));
      continue;
    }
    if (reference.ended && existsSync(path.join(folder, "session.md"))) {
      // Saved after it ended, unless the transcript has changed since: a resumed session.
      const transcript = locate(root, reference);
      if (!transcript || (await stat(transcript)).mtimeMs <= (await stat(path.join(folder, "session.md"))).mtimeMs) continue;
    }
    try {
      if (await saveSession(root, folder, reference, registry)) out.info(`Saved ${path.relative(root, folder)}/session.md`);
    } catch (error) {
      out.warn(`Couldn't save session ${reference.sessionId.slice(0, 8)}: ${(error as Error).message}`);
    }
  }
  if (vscode) out.info("VS Code sessions aren't saved as transcripts yet.");

  return references
    .filter(({ folder }) => path.basename(path.dirname(folder)) === date)
    .map(({ folder, reference }) => ({
      time: new Date(reference.started).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      tool: reference.tool === "claude" ? "Claude Code" : reference.tool === "copilot" ? "Copilot CLI" : "VS Code",
      task: reference.task,
      file: existsSync(path.join(folder, "session.md")) ? `${path.basename(folder)}/session.md` : null,
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

function validReference(value: unknown): value is SessionReference {
  if (!value || typeof value !== "object") return false;
  const r = value as SessionReference;
  return r.version === 1 && ["claude", "copilot", "vscode"].includes(r.tool) &&
    typeof r.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(r.sessionId) &&
    typeof r.started === "string" && Number.isFinite(Date.parse(r.started)) &&
    typeof r.workingDir === "string" && WORKING_DIR.test(r.workingDir);
}

const WORKING_DIR = /^(\.|worktrees\/[A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** What this machine recorded about a session it ran, if it did. */
function readProvenance(root: string, r: Pick<SessionReference, "tool" | "sessionId">): { workingDir: string } | null {
  try {
    const trusted = JSON.parse(readFileSync(provenanceFile(root, r), "utf8"));
    if (trusted.tool !== r.tool || trusted.sessionId !== r.sessionId || typeof trusted.workingDir !== "string" || !WORKING_DIR.test(trusted.workingDir)) return null;
    return { workingDir: trusted.workingDir };
  } catch { return null; }
}

function provenanceFile(root: string, r: Pick<SessionReference, "tool" | "sessionId">): string {
  const name = createHash("sha256").update(`${path.resolve(root)}:${r.tool}:${r.sessionId}`).digest("hex");
  return safePath(configDir(), `session-provenance/${name}.json`);
}
