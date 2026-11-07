// Renders a Claude Code or Copilot CLI transcript as the conversation it was.

export interface RenderOptions {
  /** Include the assistant's thinking blocks. Off by default — verbose and internal. */
  thinking: boolean;
  /** Lines of tool output to keep before truncating. */
  maxOutputLines: number;
  /** Include subagent (sidechain) turns. */
  sidechains: boolean;
}

export interface SessionMeta {
  sessionId: string;
  started: string;
  ended: string;
  date: string;
  userMessages: number;
  assistantTurns: number;
  toolCalls: number;
  gitBranch: string;
  cwd: string;
}

interface Entry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: { role?: string; content?: unknown; model?: string };
}

/** Local wall-clock date, matching how the rest of the workspace treats dates. */
function localDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString("en-CA");
}

function localTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * System reminders are context the harness injects into a user turn, not
 * anything a person said. Dropping them is what makes the export read as the
 * conversation it actually was.
 */
function stripInjectedContext(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .trim();
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;

  return [
    ...lines.slice(0, maxLines),
    `… ${lines.length - maxLines} more line(s) truncated`,
  ].join("\n");
}

function renderToolUse(block: any, options: RenderOptions, redact: (t: string) => string): string {
  const input = block.input ?? {};
  const name = String(block.name ?? "tool");

  // A Bash call reads far better as the command itself than as JSON.
  if (typeof input.command === "string") {
    const description = input.description ? `: ${input.description}` : "";
    return [
      `**${name}**${description}`,
      "",
      "```bash",
      redact(truncate(input.command, options.maxOutputLines)),
      "```",
    ].join("\n");
  }

  const summary = JSON.stringify(input, null, 2);
  return [`**${name}**`, "", "```json", redact(truncate(summary, options.maxOutputLines)), "```"].join("\n");
}

function renderToolResult(block: any, options: RenderOptions, redact: (t: string) => string): string {
  const content =
    typeof block.content === "string"
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .map((part: any) => (typeof part?.text === "string" ? part.text : "[non-text]"))
            .join("\n")
        : "";

  if (!content.trim()) return "";

  const label = block.is_error ? "Result (error)" : "Result";
  return [
    `<details><summary>${label}</summary>`,
    "",
    "```",
    redact(truncate(content, options.maxOutputLines)),
    "```",
    "",
    "</details>",
  ].join("\n");
}

export interface RenderedSession {
  markdown: string;
  meta: SessionMeta;
}

/**
 * Renders one session transcript as the conversation it was.
 *
 * Tool output is truncated rather than dropped: the point of keeping these is to
 * be able to see what was done and why, and a session that syncs 191 Confluence
 * pages would otherwise produce a file nobody opens.
 */
export function renderSession(
  entries: Entry[],
  options: RenderOptions,
  tool: "claude" | "copilot",
  redact: (text: string) => string,
): RenderedSession {
  const toolName = tool === "copilot" ? "Copilot" : "Claude";

  const relevant = entries.filter(
    (entry) =>
      (entry.type === "user" || entry.type === "assistant") &&
      (options.sidechains || !entry.isSidechain) &&
      !entry.isMeta,
  );

  const meta: SessionMeta = {
    sessionId: relevant[0]?.sessionId ?? "unknown",
    started: relevant[0]?.timestamp ?? "",
    ended: relevant[relevant.length - 1]?.timestamp ?? "",
    date: relevant[0]?.timestamp ? localDate(relevant[0].timestamp) : "",
    userMessages: 0,
    assistantTurns: 0,
    toolCalls: 0,
    gitBranch: relevant[0]?.gitBranch ?? "",
    cwd: relevant[0]?.cwd ?? "",
  };

  const body: string[] = [];
  let lastSpeaker = "";

  for (const entry of relevant) {
    const time = entry.timestamp ? localTime(entry.timestamp) : "";
    const content = entry.message?.content;
    const parts: string[] = [];

    if (entry.type === "user") {
      if (typeof content === "string") {
        const text = stripInjectedContext(content);
        if (!text) continue;

        meta.userMessages += 1;
        body.push(`\n## User · ${time}\n\n${redact(text)}`);
        lastSpeaker = "user";
        continue;
      }

      if (Array.isArray(content)) {
        for (const block of content as any[]) {
          if (block.type === "tool_result") {
            const rendered = renderToolResult(block, options, redact);
            if (rendered) parts.push(rendered);
          } else if (block.type === "text") {
            const text = stripInjectedContext(String(block.text ?? ""));
            if (text) {
              meta.userMessages += 1;
              body.push(`\n## User · ${time}\n\n${redact(text)}`);
              lastSpeaker = "user";
            }
          } else if (block.type === "image") {
            body.push(`\n## User · ${time}\n\n_[image attached]_`);
            lastSpeaker = "user";
          }
        }

        // Tool results belong under the assistant turn that made the call.
        if (parts.length > 0) body.push(parts.join("\n\n"));
        continue;
      }

      continue;
    }

    if (!Array.isArray(content)) continue;

    meta.assistantTurns += 1;
    for (const block of content as any[]) {
      if (block.type === "text" && String(block.text ?? "").trim()) {
        parts.push(redact(String(block.text)));
      } else if (block.type === "thinking" && options.thinking) {
        parts.push(
          `<details><summary>Thinking</summary>\n\n${redact(String(block.thinking ?? ""))}\n\n</details>`,
        );
      } else if (block.type === "tool_use") {
        meta.toolCalls += 1;
        parts.push(renderToolUse(block, options, redact));
      }
    }

    if (parts.length === 0) continue;

    if (lastSpeaker !== "assistant") body.push(`\n## ${toolName} · ${time}`);
    body.push(`\n${parts.join("\n\n")}`);
    lastSpeaker = "assistant";
  }

  const frontmatter = [
    "---",
    `tool: ${JSON.stringify(tool)}`,
    `session: ${JSON.stringify(meta.sessionId)}`,
    `date: ${JSON.stringify(meta.date)}`,
    `started: ${JSON.stringify(meta.started)}`,
    `ended: ${JSON.stringify(meta.ended)}`,
    `userMessages: ${meta.userMessages}`,
    `assistantTurns: ${meta.assistantTurns}`,
    `toolCalls: ${meta.toolCalls}`,
    `gitBranch: ${JSON.stringify(meta.gitBranch)}`,
    "---",
  ].join("\n");

  const header = [
    `# Work session · ${meta.date}`,
    "",
    `${meta.userMessages} user message(s), ${meta.assistantTurns} assistant turn(s), ${meta.toolCalls} tool call(s).`,
    `${localTime(meta.started)} to ${localTime(meta.ended)}${meta.gitBranch ? ` on \`${meta.gitBranch}\`` : ""}.`,
    "",
    `Exported from the ${tool === "copilot" ? "Copilot CLI session" : "Claude Code transcript"}. Tool output is truncated to ${options.maxOutputLines} lines;`,
    "injected system reminders are omitted. Secrets are redacted, but read before sharing.",
  ].join("\n");

  return { markdown: `${frontmatter}\n\n${header}\n${body.join("\n")}\n`, meta };
}
