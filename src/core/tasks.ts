import { createHash } from "node:crypto";
import { safePath } from "./files.ts";
import { createOnly } from "./files.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { splitFrontMatter } from "./front-matter.ts";
import { DevError } from "./output.ts";
import { isBranchName, type ProjectConfig } from "./project-config.ts";
import { defaultBranch } from "./worktree.ts";

/**
 * Task notes in tasks/<id>/: the brief, the progress note, and later decisions and the
 * PR description. They're the person's and the agent's, so nothing ever overwrites or
 * removes them, unlike worktrees.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function taskDir(root: string, id: string): string {
  return safePath(root, `tasks/${id}`);
}

/** A task id from a reference or a name: kept as it is if it's already a safe folder name. */
export function taskId(text: string): string {
  const trimmed = text.trim();
  if (ID.test(trimmed)) return trimmed;
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!slug) throw new DevError(`"${text}" can't be used as a task name.`, "Use letters, digits, dots, hyphens or underscores.");
  return `${slug.slice(0, 51)}-${createHash("sha256").update(trimmed).digest("hex").slice(0, 12)}`;
}

/** The id the same reference got before ids carried a hash, so tasks started then are resumed, not duplicated. */
export function legacyTaskId(text: string): string | null {
  const trimmed = text.trim();
  if (ID.test(trimmed)) return trimmed;
  return trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || null;
}

export interface BriefContext {
  id: string;
  title: string;
  branch: string;
  /** The branch the task started from, and merges back into. */
  base: string;
  /** Files in the workspace about this task, relative to the workspace root. */
  sources: string[];
  /** Whether the code repository has a PR template. */
  prTemplate: string | null;
  /** Links outside the scope, not fetched. */
  notFetched?: string[];
}

function brief(context: BriefContext): string {
  const sources =
    context.sources.length > 0
      ? context.sources.map((file) => `- [${file.split(path.sep).join("/")}](${path.posix.relative(`tasks/${context.id}`, file.split(path.sep).join("/"))})`).join("\n")
      : "_None found. Add links to the ticket, specs and designs this task needs._";
  const outside =
    context.notFetched && context.notFetched.length > 0
      ? `\n\nOutside this workspace's scope, so not fetched. Each says how to fetch it:\n\n${context.notFetched.map((link) => `- ${link}`).join("\n")}`
      : "";

  const prDescription = context.prTemplate
    ? `following the repository's own template at \`repository/${context.prTemplate}\`, with the same headings`
    : "saying what changed and why, and how it was tested";

  return `---
id: ${JSON.stringify(context.id)}
title: ${JSON.stringify(context.title)}
branch: ${JSON.stringify(context.branch)}
base: ${JSON.stringify(context.base)}
worktree: ${JSON.stringify(`worktrees/${context.id}`)}
round: 1
sources: [] # workspace files that matter but the Sources links don't reach; dev sync watches them too
---

# ${context.title}

> Written by \`dev task start\`. Fill in the sections from the sources below, then keep
> this as the thing you load for this task, not the raw sources.

## Sources

${sources}${outside}

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
    if (!await createOnly(file, content)) continue;
    written.push(path.join("tasks", context.id, name));
  }
  return written;
}

/**
 * The base recorded in a task's brief, or null for a brief from before dev recorded it, a
 * review worktree with no brief, or a brief someone rewrote without it.
 */
export async function taskBase(root: string, id: string): Promise<string | null> {
  try {
    const base = splitFrontMatter(await readFile(path.join(taskDir(root, id), "brief.md"), "utf8")).data?.base;
    return isBranchName(base) ? base : null;
  } catch {
    return null;
  }
}

/** The base new tasks start from: dev.yaml's conventions.base, else the repository's default branch. */
export async function workspaceBase(repo: string, config: ProjectConfig): Promise<string> {
  return config.conventions.base ?? (await defaultBranch(repo));
}

/** Each task's own base, from its brief; the workspace's for a brief from before dev recorded it, or no brief. */
export function basesFor(root: string, fallback: string): (id: string) => Promise<string> {
  return async (id) => (await taskBase(root, id)) ?? fallback;
}
