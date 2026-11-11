# dev: design

`dev` is a command-line tool that sets up a workspace around one code repository and keeps
the information around it (tickets, specs, docs, designs, PRs) in local files. People and AI
agents use the same commands to gather what a task needs, do the work, review the changes
and hand it over.

This document sets out the decisions that shape everything else.

Status: phase 5 complete: Figma, GitLab, Notion and GitHub Projects. Open questions are at the end.

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

- **One item per folder where people add files.** Jira keeps each ticket as
  `jira/<KEY>/ticket.md`, so research notes or images can sit beside it. A sync only ever
  writes `ticket.md`.
- **One folder per service**, named after it. The plugin decides what goes inside, with an
  `index.md` that the core builds from front matter.
- **Task notes live in `tasks/`**, not in a service's folder. A sync owns its folder and may
  rewrite it; notes must survive that. A task's folder name is its item's id, like
  `ABC-123` or `issue-42`.
- Synced files are never edited by hand. Everything under `tasks/` is the person's and the
  agent's.

Synced items are written so that a file whose only change would be its sync time is left
exactly as it was. Without that, every sync would rewrite every file and the diff would bury
what actually moved.

Items fetched on demand, like a parent ticket or a page a PR links to, carry
`inScope: false`, so a sync that prunes items which left the scope never removes them.

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
| `inScope` | no | Whether the item is in its service's scope |
| `via` | no | Why it's here: `scope`, `parent`, `linked`, `pulled` or `former` |
| `mine` | no | Whether it's assigned to the person running dev, for services with assignees |

The core builds each folder's `index.md` from these fields, so every index has the same
columns and agents read them the same way: ID, Title, Status and Updated, plus Mine and Why
where the service records them. A one-line legend says that only `scope` items are the
work; the rest are context. For "what's mine?", agents run `dev task list --mine`, which
reads the same front matter through each task source's `tasks` capability.

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
    scope: { project: ABC, jql: "assignee = currentUser() AND statusCategory != Done" }
  - service: atlassian:confluence
    scope: { roots: [12345, 67890] }
plugins:
  # pinned versions, once plugins can come from outside the core
conventions:
  branch: "{type}/{id}-{slug}"
```

Each service validates its own `scope`. `dev doctor` checks the whole file.

### Syncing and the scope boundary

Each service entry can also say how it syncs and what it may fetch:

```yaml
  - service: atlassian:confluence
    scope: { spaces: [DOCS] }
    sync: referenced     # default full
    fetch: anywhere      # default within-scope
```

- **`fetch`:** with `within-scope`, the default, a service never fetches an item outside
  its scope, even when a task or PR links to it. Briefs and PRs list those links as
  outside the scope, so a person can open them. Companies wary of AI reading everything
  keep the default. Like the command check, this limits dev, not the token.
- **`sync`:** task sources, like Jira, always sync their whole scope. Other services can
  sync `referenced`: they only update the items already in the workspace and fetch new
  ones that open tasks or PRs point to. `dev sync --referenced` does the same for one run.
- **Every sync ends with a sweep:** what open tasks and open PRs point to is fetched from
  the other services, within their scope.
- **Nothing is removed for leaving the scope.** A ticket or page tree that left it, or a PR
  that was merged, keeps its file, marked `inScope: false` or with its new status. Files are
  cheap, and the history is worth keeping. Within a Confluence tree, a page renamed or moved
  in Confluence still replaces its old folder, so there's one copy of each page.

A service that holds tasks implements the `tasks` capability: a list of its tasks with an
id, title, status, whether it's done, whether it's assigned to the person, and a due date.
That tells the core which items drive the sweep, without a shared ticket model.

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
| `dev sync [service] [--referenced]` | Sync every enabled service, or one; with `--referenced`, docs services only keep what tasks point to |
| `dev day start`, `dev day end` | Refresh and write the snapshot; save sessions and the day summary |
| `dev task start <ref>` | Fetch the item and what it links to, create the worktree and notes |
| `dev task list [--mine] [--all] [--refresh]` | The tasks from every task source, from the last sync: what's yours, what's open |
| `dev task status [id]`, `dev task cleanup` | What's in flight; which worktrees can go |
| `dev check "<command>"` | What the command check decides, without running anything |
| `dev github prs`, `dev github pr <N>` | Find and pull the PRs to review; pull one PR |
| `dev <service> scope [add\|remove <items>] [--set <scope>]` | Show or change a service's scope; add and remove take links or ids where the scope is a list |
| `dev <service> <action>` | Each service's own commands, like `dev jira pull ABC-1` or `dev confluence pull <page>` |
| `dev hook <event>` | Run by tool hooks |

`<ref>` is anything a service recognises: a key, an issue number or a URL.

### `dev init`

1. Pick the versioning service, from the installed plugins.
2. Log in to it, then pick the repository from the list it offers.
3. Pick the connected services.
4. Log in to each plugin not logged in yet. A plugin's later services reuse its login.
5. Pick each service's scope.
6. Write `dev.yaml`, the folders, agent files, hooks, skills, docs and MCP entries.
7. Clone the repository, then run `dev day start` separately.

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

Changing the workspace's config is its own kind, `config`: `dev add`, `remove`, `login`,
`logout`, changing a scope, and any edit to `dev.yaml` or the dev settings folder, whether
through a shell command or a file-editing tool. The hooks cover both. It asks by default,
and a team can set it to `deny` so agents can't widen what they're allowed to read.

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

## Figma

Figma records the designs that tasks and PRs link to, as `figma/<fileKey>-<nodeId>/design.md`:
which file and frame, and how to read it through the Figma desktop app's local MCP server.
Agents read designs there, never from the web link. The workspace's MCP config points at
the local server.

A login is optional. Not everyone will create a token, so the plugin works without one,
doing less.

Each sync fingerprints every recorded frame's content and records when it changed:

- **With a personal access token** (read-only file content), through Figma's REST API: one
  request per file, for any file, without Figma desktop running.
- **Without one**, the local MCP can inspect whichever file is open, but cannot establish
  its file identity. Checks are reported as unverified and do not update authoritative
  change-detection fingerprints. A token is required for verified change detection.

Desktop metadata is never compared with verified REST fingerprints. Designs that changed in the last week appear in the snapshot.

## GitLab

GitLab works on gitlab.com or a self-hosted server: the login asks for the server and a
personal access token with the `read_api` scope. Its versioning service lists projects,
clones (over HTTPS with the token for that one clone, or over SSH with `--clone-url`) and
pulls merge requests to review into `merge-requests/<N>/`. GitLab Issues is a task source,
like Jira and GitHub Issues, in `gitlab-issues/<group>-<project>-<N>/issue.md`. The command
check knows `glab` as it knows `gh`.

Only projects the workspace knows count as GitLab issue references, so `owner/name#12`
isn't claimed by GitLab when it means a GitHub issue.

## Notion

Notion is a docs source, like Confluence: each root page or database in scope is mirrored
with everything under it, one folder per page, as `notion/<Title-id>/index.md`. A database
gets a page listing its rows, and each row is a page with its properties in front matter.
The login is an internal integration's secret, and the integration only sees pages someone
has connected it to in Notion, on top of the scope. Pages whose last edit hasn't changed
aren't fetched again, and file links Notion signs for an hour are named, not written.

## GitHub Projects

GitHub Projects is a task source on the GitHub login, through GraphQL, which needs the
`read:project` scope. Each item on a board in scope, whether an issue, a PR or a draft,
becomes `github-projects/<owner>-<number>/<item>/item.md`, with the board's own fields,
like Status or Iteration. An item counts as done when its status says so, or its issue or
PR is closed. A field whose name mentions due or target date becomes the due date.

## What phase 4 taught the interface

GitHub Issues was added as a second task source, to test the interface. It needed two
changes, both small:

- **`links.find` gets the service's context, not just its scope.** Recognising "closes #42"
  needs the workspace's own repository, which lives in `dev.yaml`, not in the scope.
- **Syncing a task source sweeps every service.** `dev sync github-issues` now fetches what
  the issues point to from Confluence or any other service, as a full sync already did.

Everything else, from `dev task list` and the snapshot to task start, the indexes and the
sweep, worked through the `tasks`, `links` and `contribute` capabilities unchanged.

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
