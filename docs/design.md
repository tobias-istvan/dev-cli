# dev: design

`dev` is a command-line tool that sets up a workspace around one code repository and keeps
the information around it (tickets, specs, docs, designs, PRs) in local files. People and AI
agents use the same commands to gather what a task needs, do the work, review the changes
and hand it over.

This document sets out the decisions that shape everything else.

Status: phase 2 complete (GitHub versioning and PR review, init, tasks, the day, sessions, hooks, command check). Open questions are at the end.

## Goals

- **Gather the context for a task**: one command collects the ticket, its specs, designs
  and related items into files an agent can read.
- **Keep work reviewable**: each task has its own worktree, notes and handover, and nothing
  reaches a shared service without the person deciding.
- **Work for people and any agent**: plain files and terminal commands, with extra
  automation where a tool supports hooks.
- **Fit any team's tools**: sources are plugins, and a project picks the ones it uses.

## Non-goals, for now

- More than one code repository per workspace
- Windows
- Cloud agents
- A sandbox. An agent runs as the person, so credentials outside the workspace and the
  command check are guardrails, not security boundaries. The docs say so plainly.
- A shared data model across sources. Each source writes its own files (see Folder layout).

## Concepts

| Term | Meaning |
| --- | --- |
| Workspace | A folder with a `dev.yaml`, the agent files, the source folders and one cloned repository |
| Plugin | A package that knows one vendor, like GitHub or Atlassian, and owns its login |
| Service | One thing a plugin offers, like GitHub versioning, GitHub Issues, Jira or Confluence. A project enables services one by one |
| Versioning service | The service that hosts the code. Exactly one per workspace |
| Connected service | Any other enabled service: trackers, docs, boards, designs |
| Scope | What a service syncs: a board and filter, a set of spaces or pages, a project |
| Task | A unit of work, started from an item in any service, with its own worktree and notes |

A plugin with several services shares one login across them. Atlassian offers Jira and
Confluence; GitHub offers versioning, Issues and Projects. A team that hosts code on GitHub
but tracks work in Jira enables only `github:github` (its versioning service) and
`atlassian:jira`.

## Folder layout

```
my-workspace/
  dev.yaml                  project config, committed
  AGENTS.md, CLAUDE.md      generated agent instructions
  .github/, .claude/, .agents/   hooks, skills and MCP entries for each tool
  docs/                     core docs plus each service's docs
  snapshot.md               what to work on, rebuilt by day start
  repository/               the code clone (gitignored)
  worktrees/<task>/         one checkout per task (gitignored)
  tasks/<task>/             brief, progress, decisions, PR description: never deleted
  pull-requests/<N>/        PRs under review and their review.md
  work-sessions/<date>/     day summaries and saved sessions
  jira/, confluence/, github-issues/, notion/, ...   one folder per connected service
```

- **One folder per service**, named after it. The plugin decides what goes inside, with an
  `index.md` that the core builds from front matter.
- **Task notes live in `tasks/`**, not in a service's folder. A sync owns its folder and may
  rewrite it; notes must survive that. A task's folder name is its item's id, like
  `ABC-123` or `issue-42`.
- Synced files are never edited by hand. Everything under `tasks/` is the person's and the
  agent's.

### Front matter

Every synced item is a Markdown file whose front matter starts with the common fields. A
plugin may add its own after them.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The item's id in its service, like `ABC-123` |
| `title` | yes | Its title |
| `service` | yes | The service that wrote it, like `atlassian:jira` |
| `url` | yes | Where it lives on the web |
| `updated` | yes | When it last changed in the service |
| `synced` | yes | When this file was written |
| `status` | no | The service's own status words |
| `parent` | no | The id of a parent item, when the service has one |
| `links` | no | References to other items, as URLs or ids |

The core builds each folder's `index.md` from these fields, so every index has the same
columns and agents read them the same way.

## Configuration

### Project config: `dev.yaml`

Committed with the workspace, so a team shares one setup. It never holds credentials.

```yaml
version: 1
versioning:
  service: github:github
  repo: acme/web
services:
  - service: atlassian:jira
    scope: { project: ABC, filter: "assignee = currentUser() AND statusCategory != Done" }
  - service: atlassian:confluence
    scope: { roots: [12345, 67890] }
plugins:
  # pinned versions, once plugins can come from outside the core
conventions:
  branch: "{type}/{id}-{slug}"
```

Each service validates its own `scope`. `dev doctor` checks the whole file.

### Home config

Per person, outside every workspace, in `$XDG_CONFIG_HOME/dev/` (default `~/.config/dev/`):

- `credentials/<plugin>.json`: every account for that plugin, and which is the default.
  The folder is owner-only (700) and the file too (600). Writes go through a temporary
  file, so a crash never leaves half a file
- `policy.json`: the command check's decisions (see Command check)

A plugin can also borrow another tool's login instead of storing a secret. The GitHub
plugin's `cli` method saves only the name of a `gh` account, and asks `gh auth token
--user <account>` for its token each time. That works with several `gh` accounts, whichever
is active.

An OS keychain can come later behind the same interface. For scripts, environment
variables named `DEV_<PLUGIN>_<KEY>`, like `DEV_ATLASSIAN_TOKEN`, override the default
account's values.

### Generated files

`dev files` writes `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, a skill
per service in each tool's skill folder, service docs, MCP entries and a managed block in
`.gitignore`. Every command table comes from the command tree itself, so the docs can't
drift from the commands.

dev records a hash of each file it writes in `.dev/generated.json`. A file still as dev
wrote it is updated; a file someone edited is left alone and listed; a file that no longer
applies is removed only if nobody edited it. `.gitignore` keeps every line outside dev's
block.

## Commands

| Command | Does |
| --- | --- |
| `dev init [folder]` | The setup wizard. Safe to run again |
| `dev doctor` | Checks config, logins, scopes and required tools, with a fix for each problem |
| `dev files` | Updates the generated agent files from `dev.yaml`, leaving hand-edited ones alone |
| `dev index [service]` | Rebuilds service folders' `index.md` from front matter |
| `dev add <service>`, `dev remove <service>` | Enable or disable one service, as init does |
| `dev login <plugin>`, `dev logout <plugin>` | Log in or out. People only, never agents |
| `dev sync [service]` | Sync every enabled service, or one |
| `dev day start`, `dev day end` | Refresh and write the snapshot; save sessions and the day summary |
| `dev task start <ref>` | Fetch the item and what it links to, create the worktree and notes |
| `dev task status [id]`, `dev task cleanup` | What's in flight; which worktrees can go |
| `dev check "<command>"` | What the command check decides, without running anything |
| `dev github prs`, `dev github pr <N>` | Find and pull the PRs to review; pull one PR |
| `dev <service> <action>` | Each service's own commands, like `dev jira pull ABC-1` or `dev confluence scope` |
| `dev hook <event>` | Run by tool hooks |

`<ref>` is anything a service recognises: a key, an issue number or a URL.

### `dev init`

1. Pick the versioning service, from the installed plugins.
2. Log in to it, then pick the repository from the list it offers.
3. Pick the connected services.
4. Log in to each plugin not logged in yet. A plugin's later services reuse its login.
5. Pick each service's scope.
6. Write `dev.yaml`, the folders, agent files, hooks, skills, docs and MCP entries.
7. Clone the repository, and with `--sync`, run the first `dev day start`.

Every question has a flag, so init can run without a terminal. Running it again on an
existing workspace keeps what's there and offers what's missing.

## Plugin interface

A plugin is a module that exports a manifest and its services. Each part below is a
capability; a service implements the ones that apply.

### Plugin level

| Capability | What it provides |
| --- | --- |
| Manifest | Name, version, minimum core version, services, login methods |
| Login | Log in (OAuth or token), check, log out. The core stores the result |
| Secrets | Values and patterns to redact from saved sessions |
| Command policy | Which of its CLI's commands change things, like `gh pr merge` |

### Service level

| Capability | What it provides |
| --- | --- |
| Scope | List the choices, let the person pick, validate a saved scope |
| Sync | Full and incremental runs with saved position, pull one item, prune items that left scope, never stop on one failure, report what changed |
| Link resolution | Recognise its references in any text, and fetch one on demand |
| Contributions | A snapshot section, session-start lines, day-end facts, and task-start context |
| Commands | Its own subcommands, each marked read or change, with help text |
| Agent files | Skills, docs, `AGENTS.md` rows, rules, `.gitignore` lines, MCP entries |
| Doctor | Checks for its scope, login and tools |
| Test mode | Recorded responses, so tests never reach the service |

The versioning service adds: list repositories, clone, default branch, branch naming,
and PRs to review.

### How plugins reach the core

- Each command, help text, skill table and `AGENTS.md` row is generated from manifests,
  so docs can't drift from the commands.
- Version 0.x ships its plugins inside the package. Outside plugins come later, as npm
  packages pinned in `dev.yaml`. They run with the person's credentials, so installing one
  is an explicit step.

## Command check

Before an agent runs a shell command, a hook asks each plugin's command policy about the
CLIs it knows, for every plugin. Reads run, changes ask the
person, anything that can't be followed asks, and commands no plugin knows are left to the
tool. Plugins' own `dev` subcommands are covered the same way, from their read or change
marks.

The person's decisions live in `policy.json` in the dev config folder: `read`, `change`
and `unknown` defaults, plus per-command rules like `"gh pr create": "allow"`, where the
longest match wins. `gh auth token` is denied by default because it prints a token, and
help is always a read.

## Following references

A service's links capability recognises its own references in any text. When one service
finds text that may point elsewhere, like a PR's title and description, the core asks every
enabled service and fetches what they recognise. That is how a PR pulls in its ticket and a
task's brief links to its specs, without any service knowing about the others.

## Agents and tools

| Tool | Support |
| --- | --- |
| Copilot CLI, Claude Code | Hooks add context at session start, save the session at the end, and run the command check |
| Any other agent | Reads `AGENTS.md` and the skills, and runs `dev day start` and `dev day end` by hand |

Rules every agent follows, written into `AGENTS.md`: never push or open a PR unless asked in
the session, no other writes to a service unless asked each time, never handle credentials,
never commit sync output, read indexes before files.

## Technical choices

| Choice | Decision | Why |
| --- | --- | --- |
| Language | TypeScript, shipped as compiled JavaScript | Type-checked, and runs wherever Node does |
| Runtime | Node 22 or later | The oldest maintained LTS line, so most machines already have it |
| Commands | Commander | Mature, with generated help |
| Prompts | `@inquirer/prompts` | Stable, and supports lists and search for long repo lists |
| Config format | YAML | People edit it by hand, and it allows comments |
| Tests | `node:test` with recorded responses | No extra framework |
| Distribution | Public npm package `@tobias.istvan/dev`, command `dev` | `npm i -g @tobias.istvan/dev`, no repository access needed |
| Licence | MIT | |

## Phases

1. **Core**: framework, workspace detection, home credential store, `dev.yaml` and
   `dev doctor`, plugin interface and registry, generated docs, scaffolding.
2. **`dev init` and GitHub versioning**: the wizard, clone, worktrees, day start and end,
   sessions, hooks and the command check.
3. **Atlassian**: Jira and Confluence ported as services, `task start`, `add`, `remove`,
   `scope` and `login`.
4. **GitHub Issues**: a second tracker, to prove the interface without core changes.
5. **More plugins**: Notion, GitLab, GitHub Projects, Figma.
6. **Release**: CI, npm publishing, README and getting started, then 0.1.0.

## Open questions

- **npm account.** Publishing `@tobias.istvan/dev` needs an npm user or organisation
  called `tobias.istvan`. Needed by phase 6.
- **Task folder names** when two services use the same id format.
- **Command name clashes.** Another tool may already install `dev`. Worth an alias, like
  `devw`, if it turns out to be common.
- **Keychain.** Whether to store credentials in the OS keychain from the start.
