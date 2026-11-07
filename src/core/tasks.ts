import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DevError } from "./output.ts";

/**
 * Task notes in tasks/<id>/: the brief, the progress note, and later decisions and the
 * PR description. They're the person's and the agent's, so nothing ever overwrites or
 * removes them, unlike worktrees.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function taskDir(root: string, id: string): string {
  return path.join(root, "tasks", id);
}

/** A task id from a reference or a name: kept as it is if it's already a safe folder name. */
export function taskId(text: string): string {
  const trimmed = text.trim();
  if (ID.test(trimmed)) return trimmed;
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!slug) throw new DevError(`"${text}" can't be used as a task name.`, "Use letters, digits, dots, hyphens or underscores.");
  return slug;
}

export interface BriefContext {
  id: string;
  title: string;
  branch: string;
  /** Files in the workspace about this task, relative to the workspace root. */
  sources: string[];
  /** Whether the code repository has a PR template. */
  prTemplate: string | null;
}

function brief(context: BriefContext): string {
  const sources =
    context.sources.length > 0
      ? context.sources.map((file) => `- [${path.basename(file)}](${path.posix.relative(`tasks/${context.id}`, file.split(path.sep).join("/"))})`).join("\n")
      : "_None found. Add links to the ticket, specs and designs this task needs._";

  const prDescription = context.prTemplate
    ? `following the repository's own template at \`repository/${context.prTemplate}\`, with the same headings`
    : "saying what changed and why, and how it was tested";

  return `---
id: ${JSON.stringify(context.id)}
title: ${JSON.stringify(context.title)}
branch: ${JSON.stringify(context.branch)}
worktree: ${JSON.stringify(`worktrees/${context.id}`)}
---

# ${context.title}

> Written by \`dev task start\`. Fill in the sections from the sources below, then keep
> this as the thing you load for this task, not the raw sources.

## Sources

${sources}

## What we're building

_One paragraph: what changes, for whom, and why._

## Acceptance criteria

- [ ] …

## Constraints and decisions

_Anything that limits the approach, and decisions made along the way._

## Out of scope

## Open questions

_Anything that needs a person's answer. If one blocks the work, stop and ask._

## When done

Write \`pr-description.md\` in this folder, ${prDescription}. Leave any checkboxes
unticked: they're the author's own statements. Then stop. Pushing and opening the PR are
the person's call.
`;
}

const PROGRESS = (id: string) => `# Progress

Keep this current while working on ${id}, so the work survives the session ending.

## Done

## Next step

_The very next thing to do. Write it before stopping for any reason._

## Notes
`;

/** Writes the brief and progress note if they're missing. Never replaces either. */
export async function writeTaskNotes(root: string, context: BriefContext): Promise<string[]> {
  const dir = taskDir(root, context.id);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of [["brief.md", brief(context)], ["progress.md", PROGRESS(context.id)]] as const) {
    const file = path.join(dir, name);
    if (existsSync(file)) continue;
    await writeFile(file, content);
    written.push(path.join("tasks", context.id, name));
  }
  return written;
}
