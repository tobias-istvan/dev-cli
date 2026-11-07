import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServiceEntry } from "../plugins/types.ts";
import type { Registry } from "../plugins/registry.ts";
import { packageDir } from "./paths.ts";
import type { ProjectConfig } from "./project-config.ts";

/**
 * Writes the workspace's generated files: agent instructions, skills, docs, MCP entries
 * and .gitignore lines, from dev.yaml and the enabled services.
 *
 * Generated files can be edited by hand. dev remembers what it wrote in
 * .dev/generated.json: a file still as dev wrote it is updated, and a file someone
 * changed is left alone and reported. So re-running is always safe.
 */

/** One row of a command table: the command and what it does. */
export interface CommandRow {
  command: string;
  does: string;
}

export interface ScaffoldResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Files someone edited, left as they are. */
  differs: string[];
  /** Files dev wrote before that no longer apply, removed because nobody had edited them. */
  removed: string[];
}

const RECORD = path.join(".dev", "generated.json");
const SKILL_FOLDERS = [".github/skills", ".claude/skills", ".agents/skills"];
const GITIGNORE_START = "# >>> dev (managed: edit dev.yaml, not these lines)";
const GITIGNORE_END = "# <<< dev";

function template(name: string): string {
  return readFileSync(path.join(packageDir(), "templates", "workspace", name), "utf8");
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** The enabled services, in dev.yaml's order, with the versioning service first. */
export function enabledServices(config: ProjectConfig, registry: Registry): ServiceEntry[] {
  const keys = [...(config.versioning ? [config.versioning.service] : []), ...config.services.map((s) => s.service)];
  return keys.map((key) => registry.service(key)).filter((entry): entry is ServiceEntry => entry !== undefined);
}

function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

/** Every generated file, by path relative to the workspace root. */
export function generatedFiles(config: ProjectConfig, registry: Registry, commands: CommandRow[]): Map<string, string> {
  const files = new Map<string, string>();
  const services = enabledServices(config, registry);
  const connected = services.filter((entry) => entry.service.role === "connected");

  const skills: Array<{ name: string; description: string; content: string }> = [];
  const coreSkill = template("skills/dev-cli.md");
  const coreDescription = coreSkill.match(/^description: (.*)$/m)?.[1] ?? "";
  skills.push({
    name: "dev-cli",
    description: coreDescription,
    content: fill(coreSkill, {
      commands: commands.map((row) => `| ${cell(row.does)} | \`${row.command}\` |`).join("\n"),
    }),
  });

  for (const { service } of services) {
    for (const skill of service.agentFiles?.skills ?? []) {
      skills.push({ name: skill.name, description: skill.description, content: skillFile(skill.name, skill.description, skill.body) });
    }
    for (const doc of service.agentFiles?.docs ?? []) {
      files.set(path.posix.join("docs", doc.file), doc.content.trimEnd() + "\n");
    }
  }

  for (const skill of skills) {
    for (const folder of SKILL_FOLDERS) files.set(`${folder}/${skill.name}/SKILL.md`, skill.content);
  }

  const rules = services.flatMap(({ service }) => service.agentFiles?.rules ?? []);
  const repository = config.versioning ? `, \`${config.versioning.repo}\`` : "";

  files.set(
    "AGENTS.md",
    fill(template("AGENTS.md"), {
      repository,
      folders: connected
        .map(({ service }) => `| \`${service.id}/\` | ${cell(service.title)}: ${cell(service.description)}. Start at its \`index.md\` |`)
        .join("\n"),
      rules: rules.length > 0 ? rules.map((rule, i) => `${i + 7}. ${rule}`).join("\n") + "\n" : "",
      commands: commands.map((row) => `| \`${row.command}\` | ${cell(row.does)} |`).join("\n"),
      skills: skills.map((skill) => `| \`.github/skills/${skill.name}/SKILL.md\` | ${cell(skill.description)} |`).join("\n"),
    }),
  );
  files.set("CLAUDE.md", template("CLAUDE.md"));
  files.set(".github/copilot-instructions.md", template(".github/copilot-instructions.md"));

  // Session hooks. Guarded, so a machine without dev installed just skips them.
  const guard = (args: string, cd = false) => `command -v dev >/dev/null 2>&1 && ${cd ? 'cd "\${CLAUDE_PROJECT_DIR:-.}" && ' : ""}dev hook ${args} || true`;
  files.set(
    ".github/hooks/dev.json",
    `${JSON.stringify(
      {
        version: 1,
        hooks: {
          sessionStart: [{ type: "command", bash: guard("session-start --tool copilot"), cwd: ".", timeoutSec: 15 }],
          sessionEnd: [{ type: "command", bash: guard("session-end --tool copilot >> .dev/state/hooks.log 2>&1"), cwd: ".", timeoutSec: 60 }],
          preToolUse: [{ type: "command", bash: guard("pre-tool --tool copilot"), cwd: ".", timeoutSec: 10 }],
        },
      },
      null,
      2,
    )}\n`,
  );
  files.set(
    ".claude/settings.json",
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: guard("session-start --tool claude", true), timeout: 15 }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: guard("session-end --tool claude >> .dev/state/hooks.log 2>&1", true), timeout: 60 }] }],
          PreToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: guard("pre-tool --tool claude"), timeout: 10 }] }],
        },
      },
      null,
      2,
    )}\n`,
  );

  const mcp = services.flatMap(({ service }) => service.agentFiles?.mcp ?? []);
  if (mcp.length > 0) {
    const servers = Object.fromEntries(mcp.map((entry) => [entry.name, entry.server]));
    files.set(".mcp.json", `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
    files.set(".vscode/mcp.json", `${JSON.stringify({ servers }, null, 2)}\n`);
  }

  return files;
}

/** The lines dev manages in .gitignore. */
export function gitignoreLines(config: ProjectConfig, registry: Registry): string[] {
  const base = template("gitignore").split("\n").filter((line) => line && !line.startsWith("#"));
  const extra = enabledServices(config, registry).flatMap(({ service }) => service.agentFiles?.gitignore ?? []);
  return [...new Set([...base, ...extra])];
}

/** Replaces dev's block in .gitignore, keeping every other line. */
function updateGitignore(root: string, lines: string[]): "created" | "updated" | "unchanged" {
  const file = path.join(root, ".gitignore");
  const block = [GITIGNORE_START, ...lines, GITIGNORE_END].join("\n");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;

  let next: string;
  if (existing === null) {
    next = `${block}\n`;
  } else {
    const start = existing.indexOf(GITIGNORE_START);
    const end = existing.indexOf(GITIGNORE_END);
    next =
      start !== -1 && end > start
        ? existing.slice(0, start) + block + existing.slice(end + GITIGNORE_END.length)
        : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;
  }

  if (next === existing) return "unchanged";
  writeFileSync(file, next);
  return existing === null ? "created" : "updated";
}

function readRecord(root: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path.join(root, RECORD), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function scaffold(root: string, config: ProjectConfig, registry: Registry, commands: CommandRow[]): ScaffoldResult {
  const result: ScaffoldResult = { created: [], updated: [], unchanged: [], differs: [], removed: [] };
  const previous = readRecord(root);
  const record: Record<string, string> = {};
  const files = generatedFiles(config, registry, commands);

  for (const folder of ["tasks", "worktrees", ".dev/state", ...enabledServices(config, registry).filter((e) => e.service.role === "connected").map((e) => e.service.id)]) {
    mkdirSync(path.join(root, folder), { recursive: true });
  }

  for (const [relative, content] of files) {
    const file = path.join(root, relative);
    const wanted = hash(content);

    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      record[relative] = wanted;
      result.created.push(relative);
      continue;
    }

    const current = hash(readFileSync(file, "utf8"));
    if (current === wanted) {
      record[relative] = wanted;
      result.unchanged.push(relative);
    } else if (previous[relative] === current) {
      writeFileSync(file, content);
      record[relative] = wanted;
      result.updated.push(relative);
    } else {
      // Edited by someone, or there before dev: keep it, and keep tracking dev's last version.
      if (previous[relative]) record[relative] = previous[relative];
      result.differs.push(relative);
    }
  }

  for (const [relative, recorded] of Object.entries(previous)) {
    if (files.has(relative)) continue;
    const file = path.join(root, relative);
    if (existsSync(file) && hash(readFileSync(file, "utf8")) === recorded) {
      rmSync(file);
      result.removed.push(relative);
    } else if (existsSync(file)) {
      result.differs.push(relative);
    }
  }

  const gitignore = updateGitignore(root, gitignoreLines(config, registry));
  result[gitignore].push(".gitignore");

  mkdirSync(path.join(root, ".dev"), { recursive: true });
  writeFileSync(path.join(root, RECORD), `${JSON.stringify(Object.fromEntries(Object.entries(record).sort()), null, 2)}\n`);

  for (const list of Object.values(result)) list.sort();
  return result;
}
