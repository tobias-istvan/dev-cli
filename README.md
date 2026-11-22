# dev

`dev` sets up a workspace around one code repository and keeps everything around that code
in local files: tickets, issues, project boards, specs, docs, designs and pull requests.
People and AI agents use the same commands to gather what a task needs, do the work, review
changes and hand over, without either of them reaching into a dozen web tools.

```sh
dev init ~/work/web           # pick the repository and the services the team uses
cd ~/work/web
dev day start                 # sync everything and write snapshot.md: what to work on
dev task list --mine          # your open tickets and issues
dev task start ABC-123        # worktree, branch and brief, with the ticket, its parent and its specs
```

- **One workspace per repository**, with a `dev.yaml` the team shares and commits.
- **Plugins for each service**: GitHub, GitLab, Jira, Confluence, Notion, Figma, GitHub
  Issues, GitLab Issues and GitHub Projects. A project enables only the ones it uses.
- **Built for agents too**: generated `AGENTS.md`, skills, MCP config and session hooks for
  Copilot CLI and Claude Code, and a check that asks the person before an agent changes
  anything outside the workspace.
- **Credentials stay out of the workspace**, in your home folder, readable only by you.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Getting started](#getting-started)
- [How it works](#how-it-works)
- [The workspace](#the-workspace)
- [dev.yaml](#devyaml)
- [Logins](#logins)
- [Services](#services)
- [Syncing](#syncing)
- [Tasks](#tasks)
- [Reviewing pull and merge requests](#reviewing-pull-and-merge-requests)
- [The working day](#the-working-day)
- [Working with agents](#working-with-agents)
- [The command check](#the-command-check)
- [Command reference](#command-reference)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Writing a plugin](#writing-a-plugin)
- [Licence](#licence)

## Requirements

- **macOS or Linux.** Windows isn't supported yet.
- **Node.js 22.13 or later.**
- **git.**
- **An account on the services you use**, and a token or login for each. See [Logins](#logins).
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`), so dev can reuse its login
  instead of storing a token; the [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`)
  for agents to read merge requests; the Figma desktop app for its local MCP server.

## Install

```sh
npm install -g @tobias.istvan/dev
dev --version
```

The package installs one command, `dev`. Run the same command again to update.

To uninstall, run `npm uninstall -g @tobias.istvan/dev`. Your workspaces stay, and so do
your logins in `~/.config/dev/`; delete that folder too to remove them.

### From source

```sh
git clone https://github.com/tobias-istvan/dev-cli.git
cd dev-cli
npm install
npm run build
npm link            # makes "dev" run this folder's build
```

After changing the code, run `npm run build` again; there's no need to link again.
`npm unlink -g @tobias.istvan/dev` removes the link.

## Getting started

### 1. Create a workspace

```sh
dev init ~/work/web
```

`init` asks, in order:

1. **Where the code is hosted**: GitHub or GitLab.
2. **Your login** for it, if you don't have one saved. See [Logins](#logins).
3. **Which repository**, from a list you can search by typing any part of its name.
4. **Which other services the team uses**: Jira, Confluence, Notion, Figma, GitHub Issues,
   GitLab Issues or GitHub Projects. Each asks for its own login and what to sync, its
   *scope*.

It then writes `dev.yaml`, the agent files and the hooks, and clones the code into
`repository/`. It never commits or pushes, and it's safe to run again: it keeps what
`dev.yaml` says, offers what's missing, and never overwrites a file you've edited.

`init` draws its questions with [ink](https://github.com/vadimdemedes/ink),
and heads each of its steps. Every list filters as you type and marks the letters that
matched; ↑↓, Page Up/Down, Home and End move; Tab picks and Ctrl+A picks everything shown;
Esc clears the filter. Set `DEV_PROMPTS=classic` for the usual prompts. Other commands ask
as before. See [Progress](#progress) for what every command shows while it waits.

Every question has a flag, for scripts:

```sh
dev init ~/work/web --versioning github --repo acme/web \
  --clone-url git@github.com:acme/web.git --service jira confluence
```

`--clone-url` clones over SSH with your own keys, instead of HTTPS with the login's token.

### 2. Check it

```sh
cd ~/work/web
dev doctor
```

`doctor` checks `dev.yaml`, every scope, every login (with the service itself, unless you
pass `--offline`), and the generated files, and says how to fix each problem. It also warns
about task record entries that don't follow the format; those never fail it.

### 3. Start the day

```sh
dev day start
```

This updates the code, syncs every service, and writes `snapshot.md`: what's due, what's in
progress, pull requests waiting for review, designs that changed, and what the last session
said to do next.

### 4. Work on something

```sh
dev task list --mine
dev task start ABC-123
```

`task start` creates `worktrees/ABC-123` on a new branch, and `tasks/ABC-123/brief.md`
linking the ticket, its parent and the specs and designs they point to. Open the worktree
in your editor, or ask an agent to run the `task-understand` skill for ABC-123. See
[Working through a task](#working-through-a-task).

### 5. Commit the workspace

The workspace is a Git repository of its own, separate from the code in `repository/`.
Committing it shares `dev.yaml`, briefs, reviews and day summaries with the team. Sync
output is left uncommitted for you to review first.

## How it works

### Plugins and services

A **plugin** knows one vendor and owns its login. It offers one or more **services**, which a
workspace enables one by one:

| Plugin | Services | Login |
| --- | --- | --- |
| GitHub | `github` (code, pull requests), `github-issues`, `github-projects` | Your `gh` login, or a token |
| GitLab | `gitlab` (code, merge requests), `gitlab-issues` | Server address and a token |
| Atlassian | `jira`, `confluence` | Site, email and an API token |
| Notion | `notion` | An internal integration secret |
| Figma | `figma` | Optional: a personal access token |

A team that hosts code on GitHub but tracks work in Jira enables `github:github` and
`atlassian:jira`, and nothing else.

### Two roles

- **The versioning service** hosts the code. Exactly one per workspace: `github` or `gitlab`.
- **Connected services** are everything else. Some are **task sources** (Jira, GitHub Issues,
  GitLab Issues, GitHub Projects): they hold the work. The others are **references**
  (Confluence, Notion, Figma): they hold what the work points to.

### Following references

Services don't know about each other. When text might point elsewhere, like a ticket's
description or a pull request's body, dev asks every enabled service whether it recognises
anything in it. Each recognises only its own links: Jira keys, Confluence page links,
`owner/repo#12`, Figma frame links. Whichever service recognises a link fetches it. That's how
a ticket pulls in its spec, and a pull request its ticket.

### Scope

Each connected service has a **scope**: the Jira search, the Confluence spaces or pages, the
repositories, the boards. By default a service **never fetches anything outside its scope**,
even when something links to it. Those links are listed, with their URLs, so a person can open
them or widen the scope. See [The scope boundary](#the-scope-boundary).

## The workspace

```
web/
  dev.yaml                 the project config, committed
  AGENTS.md, CLAUDE.md     instructions for agents, generated
  snapshot.md              what to work on, rewritten by dev day start
  repository/              the code (not committed)
  worktrees/<task>/        one checkout per task or review (not committed)
  tasks/<task>/            the task record: brief, logs, progress, PR description; never removed
  work-sessions/<date>/    the day's summary, source changes and saved agent sessions
  pull-requests/<N>/       GitHub pull requests to review, with review.md
  merge-requests/<N>/      GitLab merge requests to review, with review.md
  jira/<KEY>/ticket.md     one folder per ticket
  confluence/<SPACE>/...   one folder per page, following the page tree
  notion/<Title-id>/...    one folder per page, following the page tree
  github-issues/...        one folder per issue
  gitlab-issues/...        one folder per issue
  github-projects/...      one folder per board item
  figma/<file>-<node>/     one file per linked design
  docs/                    docs about each service, generated
  .github/ .claude/ .agents/   skills and hooks for each tool, generated
  .dev/                    dev's own state (logs, markers)
```

### Items and front matter

Every synced item is a Markdown file whose front matter starts with the same fields:

| Field | Meaning |
| --- | --- |
| `id` | The item's id in its service, like `ABC-123` |
| `title` | Its title |
| `service` | Which service wrote it, like `atlassian:jira` |
| `url` | Where it lives on the web |
| `updated` | When it last changed in the service |
| `synced` | When this file was written |
| `status` | The service's own status words, where it has them |
| `parent` | A parent item's id, where it has one |
| `links` | References to other items |
| `inScope` | Whether it's in the service's scope |
| `via` | Why it's here: `scope`, `parent`, `linked`, `pulled` or `former` |
| `mine` | Whether it's assigned to you, for services with assignees |

Each service adds its own fields after these, like a ticket's priority or a board item's
Iteration.

### Indexes

Each service's folder has an `index.md`, built from the front matter: one row per item, with
ID, Title, Status and Updated, plus **Mine** and **Why** where the service records them. Agents
read the index, then open only the files they need. `dev index` rebuilds them from disk.

### What's yours to edit

- **Synced files are rewritten by every sync.** Don't edit them; add notes next to them. A
  Jira ticket's folder can hold your `research.md` or images beside `ticket.md`.
- **Generated files** (`AGENTS.md`, `CLAUDE.md`, skills, hooks, MCP config, service docs) are
  updated by `dev files`, `dev add` and `dev remove`, but only while they're as dev wrote them.
  Edit one and dev leaves it alone, and says so. Its lines in `.gitignore` sit in a marked
  block; your own lines are kept.
- **`tasks/`, reviews and day summaries are yours.** Nothing ever overwrites or removes them.

### Nothing is removed for leaving the scope

A ticket that no longer matches the search, a page tree taken out of the scope, a pull
request that was merged: each keeps its file, marked with `inScope: false` and `via: former`,
or with its new status. Files are cheap, and the history is worth keeping. The one exception is
a Confluence page renamed or moved within a tree: its new folder replaces the old one, so
there's one copy of each page.

## dev.yaml

```yaml
version: 1

versioning:
  service: github:github          # or gitlab:gitlab
  repo: acme/web

services:
  - service: atlassian:jira
    scope:
      project: ABC
      jql: project = ABC AND assignee = currentUser() AND statusCategory != Done

  - service: atlassian:confluence
    scope:
      spaces: [DOCS]              # whole spaces
      roots: [12345, 67890]       # page trees from any space
    sync: referenced              # full (default) or referenced
    fetch: within-scope           # within-scope (default) or anywhere

  - service: figma:figma

conventions:
  branch: "{type}/{id}-{slug}"    # task branch names
  base: develop                   # where tasks start and merge (default: the repository's default branch)
  worktreeFiles:                  # copied from the clone into each new worktree, if git ignores them
    - apps/web/.env.local
```

| Key | Meaning |
| --- | --- |
| `versioning.service` | `github:github` or `gitlab:gitlab` |
| `versioning.repo` | `owner/name` on GitHub, `group/project` on GitLab |
| `services[].service` | `<plugin>:<service>` |
| `services[].scope` | What the service syncs. Its shape depends on the service; see [Services](#services) |
| `services[].sync` | `full` or `referenced`. See [Syncing](#syncing) |
| `services[].fetch` | `within-scope` or `anywhere`. See [The scope boundary](#the-scope-boundary) |
| `conventions.branch` | Branch names for tasks. `{type}` is `feature`, `fix` or `chore`, from the item |
| `conventions.base` | The branch tasks start from and merge into, for teams that merge into `develop` or a release branch. `dev task start --base` overrides it for one task |
| `conventions.worktreeFiles` | Local-only files, like `.env.local`, copied into each new worktree. Only files git ignores are copied, so they can't be committed by accident |
| `conventions.checks` | The repository's checks by name, like `test: npm test`. The task skills run them to plan and verify. Without it, they find the commands in the repository's `AGENTS.md`, scripts and CI config |
| `conventions.watchDays` | Days a finished task keeps getting its sources' changes in its `changes.md`, counted from its `finished` date. Default 30. The day's change report lists every change either way |

Edit it by hand or with `dev add`, `dev remove` and `dev <service> scope`. Comments are kept.
`dev doctor` checks it.

## Logins

Logins are personal and never go in the workspace. They're stored in
`~/.config/dev/credentials/<plugin>.json` (or under `$XDG_CONFIG_HOME/dev/`), in a folder and
file only you can read. One plugin can hold several accounts, with one as the default.

```sh
dev login github
dev logout github              # or --account <name> for one account
```

`dev login` needs a person at a terminal, and refuses to run for agents and scripts. Scripts
can set environment variables instead: see [Environment variables](#environment-variables).

| Plugin | How | What to create |
| --- | --- | --- |
| GitHub | **`cli`**: borrows a `gh` account's login, and stores only its name. Works with several `gh` accounts, whichever is active. **`token`**: a personal access token | Nothing for `cli`, after `gh auth login`. For projects, `gh auth refresh -s read:project` |
| GitLab | Server address and a personal access token | A token with `read_api`, at `<server>/-/user_settings/personal_access_tokens` |
| Atlassian | Site address, email and API token, for Jira and Confluence both | A token at <https://id.atlassian.com/manage-profile/security/api-tokens> |
| Notion | An internal integration secret | An integration at <https://www.notion.so/profile/integrations>, connected to the pages dev should read |
| Figma | Optional: a personal access token | Figma > Settings > Security > Personal access tokens, with "File content: read" |

Each login is checked with its service before it's saved.

## Services

### GitHub (`github:github`)

The versioning service for GitHub. Lists your repositories for `dev init`, clones, and pulls
other people's pull requests for review into `pull-requests/<N>/`. See
[Reviewing](#reviewing-pull-and-merge-requests).

### GitHub Issues (`github:github-issues`)

A task source. Each issue goes in `github-issues/<owner>-<repo>-<N>/issue.md`, with its
comments. Pull requests are left out.

```yaml
scope:
  assigned: me          # me (default) or any
  repos: [acme/web]     # default: the workspace's repository
```

It recognises `owner/repo#12`, issue links, and "closes #12" or "fixes #12" for the
workspace's own repository. A bare `#12` isn't enough: it could be a pull request.
`dev github-issues scope add <repo>` adds a repository.

### GitHub Projects (`github:github-projects`)

A task source. Each item on a board, whether an issue, a pull request or a draft, goes in
`github-projects/<owner>-<number>/<item>/item.md`, with the board's own fields, like Status,
Iteration or Priority, and an issue's or pull request's last 50 comments. Files attached in
the description or comments are downloaded into the item's `attachments/` folder, and the
text points to them; set `attachments: false` in the scope to leave them out.

```yaml
scope:
  projects: [acme/3, me/7]   # boards, as owner/number from their URL
  assigned: me               # me (default) or any
  attachments: true          # default
```

Attachments are downloaded without your login, so it never leaves GitHub's API. Images work
from private repositories too, through the short-lived addresses GitHub signs for them.
Other files from a private repository need a browser login, so they keep their GitHub link
and the sync warns about them.

An item is done when its Status says so (Done, Closed, Complete, Shipped, Released, Merged)
or its issue or pull request is closed. A field named like "Due" or "Target date" becomes its
due date. Needs the `read:project` scope.

### GitLab (`gitlab:gitlab`)

The versioning service for GitLab, on gitlab.com or your own server. Lists your projects,
clones, and pulls other people's merge requests for review into `merge-requests/<N>/`.

### GitLab Issues (`gitlab:gitlab-issues`)

A task source, like GitHub Issues, in `gitlab-issues/<group>-<project>-<N>/issue.md`.

```yaml
scope:
  assigned: me
  projects: [team/web]   # default: the workspace's project, when it's on GitLab
```

Only projects the workspace knows count as references, so a GitHub `owner/repo#12` isn't
mistaken for a GitLab issue.

### Jira (`atlassian:jira`)

A task source. Each ticket goes in `jira/<KEY>/ticket.md`: description, acceptance criteria,
relations, attachments and comments. Attachments are downloaded into the ticket's
`attachments/` folder, and images in the text point to them; set `attachments: false` in the
scope to leave them out. Your own files can sit beside it.

The search decides what the work is. `dev jira scope add <project, ticket or link>` lets
tickets in another project be fetched when something links to them, without making them
work.

```yaml
scope:
  project: ABC                       # used to tell real keys from lookalikes like UTF-8
  jql: project = ABC AND assignee = currentUser() AND statusCategory != Done
```

- Only tickets that changed in Jira are fetched again.
- The **parents** of open tickets are fetched too, since specs often live on the parent story.
  They're marked `via: parent`.
- Tickets assigned to you are marked `mine: true`.
- `dev jira pull <KEY>` fetches a ticket within the configured project boundary. With a JQL-only scope, the boundary is the projects of the tickets the search returns, so run `dev sync jira` first.
- `dev jira scope --choose` lets you pick a project, then "mine", "all open" or your own JQL.

### Confluence (`atlassian:confluence`)

A reference source. Pages are mirrored one folder per page, following the tree:
`confluence/<SPACE>/<Title-id>/<Child-id>/index.md`, with attachments beside each page and
links between pages pointing at the local files. Set `attachments: false` in the scope to
leave attachments out.

```yaml
scope:
  spaces: [DOCS]          # every top-level page of these spaces, with everything under them
  roots: [12345]          # single pages from any space, each with everything under it
```

- A tree downloads into a staging folder and replaces the old copy only once every page
  succeeded, so a failure or a killed sync never loses pages.
- `dev confluence scope --choose` picks spaces, then whole spaces or pages found by searching their
  titles. `dev confluence scope add <link or id>` adds one page; short `/wiki/x/…` links work.
- `dev confluence pull <link or id>` fetches a page and its tree, within the scope.

### Notion (`notion:notion`)

A reference source, mirrored like Confluence: `notion/<Title-id>/<Child-id>/index.md`. A
database gets a page listing its rows, and each row is a page with its properties in front
matter.

```yaml
scope:
  pages: [<page id or link>]
  databases: [<database id or link>]
```

- Only pages whose last edit changed are fetched again.
- The integration only sees pages connected to it in Notion (page menu > Connections), on top
  of the scope.
- Files Notion stores itself are named, not linked: their links expire within an hour.

### Figma (`figma:figma`)

A reference source for designs. Each Figma link in a ticket, issue or pull request becomes
`figma/<fileKey>-<nodeId>/design.md`, saying which file and frame it is, and how to read it
through the **Figma desktop app's local MCP server**, which the workspace's MCP config points
at. Agents read designs there, never from the web link.

**Change detection.** Each sync fingerprints every recorded frame's content and records when
it changed:

- **With a token**, through Figma's REST API: any file, without the desktop app.
- **Without one**, the local MCP can inspect the open design, but cannot establish its file
  identity. Checks are reported as unverified and never update change-detection baselines.
  Use a token for verified change detection.

The first check is a baseline. After that, `Design changed: <frame>` appears in the sync,
`changed:` in the file, and the snapshot lists designs that changed in the last week.
`dev figma check` checks on its own; `dev figma pull <link>` records a design by hand.

```yaml
scope:
  files: [<file key>]   # optional: only these files. Empty means any design tasks link to
```

## Syncing

```sh
dev sync                 # every service
dev sync jira            # one
dev sync --referenced    # reference sources only refresh what's here
```

1. **Each service syncs its scope.** One failing never stops the others; each failure is
   listed with its fix.
2. **The sweep:** what every open task and open pull request points to is fetched from the
   other services, within their scope. That includes tasks fetched as context, like parents.
3. **Indexes are rebuilt.**

A file whose only change would be its sync time is left exactly as it was, so `git diff`
after a sync shows only what really changed.

### Progress

Anything that waits on a service or git says what it's doing: `sync`, `day start`,
`task list --refresh`, `task start`, `task cleanup`, `doctor`, and the scope pickers.

- **At a terminal**, a live line on stderr shows a spinner, what's being fetched, how far
  along it is (like `Jira: 40 of 120 tickets`) and how long it's taken. It then leaves a
  line saying what it found.
- **Everywhere else** (agents, scripts, CI, and the background `day start` log), plain lines
  go to stderr: what started, and every 5 seconds how far it's got. No colour or cursor codes.

Results go to stdout the same way in both, so `--json` output stays only JSON. dev can't tell
a person from an agent, so it shows plain lines when stdout or stderr isn't a terminal, or
when `CI` or `CLAUDECODE` is set, or `TERM=dumb`. Set `DEV_PROGRESS=plain` to ask for them
anywhere.

### Full and referenced

| | Task sources | Reference sources |
| --- | --- | --- |
| `full` (default) | The whole scope | The whole scope |
| `referenced` | The whole scope | Only items already here, refreshed if they changed, plus what the sweep finds |

Use `referenced` when you don't want every page of a space, only what the work points to.
Set `sync: referenced` on a service in `dev.yaml` to make it its default, or pass
`--referenced` for one run.

### The scope boundary

With `fetch: within-scope`, the default, a service never fetches an item outside its scope,
even when a task links to it. To decide whether a page is inside, dev reads only its metadata,
like its space or its parents, never its content. Links outside are listed:

```
Confluence: 1 linked item is outside the scope, so not fetched:
  https://acme.atlassian.net/wiki/spaces/OPS/pages/831193102/Runbook
    linked from ABC-12, ABC-15
    to fetch it: dev confluence scope add https://acme.atlassian.net/wiki/spaces/OPS/pages/831193102/Runbook
  Then run "dev sync confluence". Or set "fetch: anywhere" for confluence in dev.yaml to follow every link.
```

Briefs and pull request files list them the same way, and a mirrored file that links to one
ends with an "Outside the scope" section giving the same command.

### Local links

A sync follows the links in open tasks, open PRs and everything in a scope, and fetches what
they point to, within each service's scope. Then it points the links in every mirrored file
at the local copies, whichever service they lead to:

```markdown
[the spec](../../confluence/DOCS/Spec-831193102/index.md "https://acme.atlassian.net/wiki/spaces/DOCS/pages/831193102/Spec")
```

The original address stays as the link's title. A link that is still a web address has no
local copy. Links inside items that were themselves fetched as links aren't followed further. This limits what dev fetches, not what
the token could reach.

### What changed

Every sync ends by working out what changed in the sources since the last one, so nobody has
to commit to see it. dev keeps each item as the last sync left it in `.dev/state/items.json`,
compares the files with it, and records:

- items added, moved, deleted in the service, gone from the workspace, or out of the scope
- front matter fields that changed, like `status: In Progress → In Review`
- body sections that changed, by heading
- comments added

A field or section that changed while the item's `updated` didn't is dev drawing the file
differently, after an upgrade say, and isn't recorded. The first sync only sets the baseline.

What changed goes in two places:

- **`work-sessions/<date>/changes.md`**: a section for each sync that changed something, each
  item with what changed and the tasks it affects. The day summary links it.
- **`tasks/<id>/changes.md`**: a `new` entry for each change to one of the task's sources,
  for every task folder, finished ones included. A task's sources are the files its brief links
  to and lists in `sources:`, the item with the task's id, and their parents and links.

```markdown
## C2 · atlassian:jira · new

- Item: [jira/ABC-123/ticket.md](../../jira/ABC-123/ticket.md)
- Changed: 2 comments added; status: In Progress → In Review; section changed: Acceptance criteria
- Report: [work-sessions/2026-11-20/changes.md](../../work-sessions/2026-11-20/changes.md)
- Recorded: 2026-11-20 09:14

ABC-123 · Sort the order list
```

Once you've worked out what an entry means for the task, set its status to `reviewed` and add
`- Led to:` with what it changed. Ids are never reused.

### One sync at a time

A running `dev sync` or `dev day start` marks itself in `.dev/state/sync.json`. Another sync
refuses to start until it's done, and `dev day status` says what's running and since when.

## Tasks

```sh
dev task list                 # open tasks in scope, and any assigned to you
dev task list --mine          # only yours
dev task list --all           # including done ones, and ones fetched as context
dev task list --refresh       # sync the task sources first
```

`task list` reads the files the last sync wrote, so it's quick and works offline, and says
when that sync was. Tasks from every task source appear together: Jira, GitHub Issues, GitLab
Issues and GitHub Projects.

### Starting a task

```sh
dev task start ABC-123
dev task start acme/web#42
dev task start "Try the new layout"      # a task with no ticket
```

1. If an enabled service recognises the reference, its item is fetched, with what it links to:
   a ticket's parent, and the Confluence pages and Figma designs either one mentions.
2. A worktree is created at `worktrees/<id>`, on a new branch from the latest base: `--base`,
   else `conventions.base`, else the default branch. The branch is named by
   `conventions.branch`. The type is `fix` for bugs and `chore` for tasks, else `feature`. The
   branch has no upstream until it's pushed.
3. Files listed in `conventions.worktreeFiles`, like `.env.local`, are copied from the clone if
   git ignores them.
4. `tasks/<id>/brief.md` and `progress.md` are written, if they aren't there. The brief records
   the base and the round, links every source, and lists links outside the scope. Its
   `sources:` is for files that matter but that those links don't reach; `dev sync` watches
   them too.

Running it again leaves the worktree, brief and progress note as they are. It never pushes.

### Rounds

One task is one ticket and one folder, with one pull request at a time. dev finds the task's
pull or merge request and writes it into the brief as `pr:`, and the day it merged as
`finished:`. It looks in `dev task status <id>`, `dev day start` and `dev task cleanup`. A
task cleaned up with no merged PR found is finished the day its worktree was removed.

When a finished task's ticket goes from done back to open, the sync marks its entry in
`changes.md` with `Reopened: yes`, and `dev task status`, the snapshot and the session start
say so. `dev task start ABC-123` on a finished task then starts its next round:

- `pr-description.md`, `verification.md` and `evidence/` move to `tasks/ABC-123/history/1/`,
  with a short `README.md` naming the PR, when it merged and the branch.
- `verification.md` starts again with the same checks, all `planned`, without the last
  round's evidence, so every criterion is checked again.
- The findings, decisions, changes and follow-ups carry on. The brief and plan are updated in
  place.
- A new branch with a suffix, like `feature/ABC-123-sort-the-order-list-2`, in
  `worktrees/ABC-123`. The brief's `round` goes up and its `pr` and `finished` are cleared.

It won't start a round while the last one's worktree is still there: run
`dev task cleanup --remove` first.

### Checking in and cleaning up

```sh
dev task status               # every task in flight: commits, uncommitted changes, how far behind, what needs attention
dev task status ABC-123       # one task's commits, changed files and record
dev task status --json        # the same, for tools
dev task diff ABC-123         # what the task changed since its branch left the base, uncommitted changes included
dev task cleanup              # which worktrees can go, and why the rest can't
dev task cleanup --remove     # remove the safe ones
```

A worktree is **safe to remove** when nothing would be lost: no uncommitted changes, and one of:

- every commit is already in the task's base, the one its brief records (a brief from before
  0.4 has none, so `conventions.base` or the default branch is used)
- every commit is on a freshly fetched remote upstream
- GitHub or GitLab has a merged pull or merge request for the branch at exactly the worktree's
  last commit. That covers squash and rebase merges, and branches the host deleted on merge.
  Without a login or a connection, only the first two count.

`tasks/<id>/` is never removed.

### The task record

`tasks/<id>/` holds the whole task. Besides the brief and the progress note, agents keep
logs there. Each entry has an id that's never reused, so entries can refer to each other:

| File | Entries | Kinds | Statuses |
| --- | --- | --- | --- |
| `findings.md` | `F1`… | `gap`, `conflict`, `missing` | `open`, `answered`, `assumed` |
| `decisions.md` | `D1`… | – | – |
| `verification.md` | `V1`… | the criterion it checks | `planned`, `passed`, `failed`, `needs-person` |
| `changes.md` | `C1`… | the source's service | `new`, `reviewed` |
| `follow-ups.md` | `O1`… | – | `noted`, `filed` |

```markdown
## F3 · conflict · open

- Sources: jira/ABC-123/ticket.md (Acceptance criteria), figma/abc-12-34/design.md
- Blocks: yes
- Answer from: the ticket's reporter

The ticket sorts the list by date; the design sorts it by name.
```

A heading with the id, the kind and the status; then fields as a list; then free text. Agents
write the files directly; dev only reads them. `dev task status ABC-123` works out the
task's state from them, even after its worktree is gone:

```
Record: tasks/ABC-123/
Round 1 · PR #42
Findings: 2 open (F1, F4), 1 blocking (F1), 1 assumed (F3), 1 answered
Decisions: 2
Source changes to review: C3
Verification: 1 of 4 checks passed · failed: V2 · needs a person: V3 · planned: V4
Follow-ups to file: O1
```

An entry that doesn't follow the format is a warning there and in `dev doctor`, never an
error: an unknown status, a duplicate id, `Blocks` that isn't yes or no, a reviewed change
with no `Led to`, a filed follow-up with no `Filed as`, an assumed finding with no decision
that resolves it, or a reference to an id that isn't in the record. For a brief from before
these logs, the questions under its "Open questions" and its ticked criteria stand in until
`findings.md` and `verification.md` exist.

### Working through a task

A skill for each phase, generated with the others into `.github/skills/`, `.claude/skills/`
and `.agents/skills/`. Ask an agent to run one for a task, like "run task-plan for
ABC-123", or let it pick one up:

| Skill | Reads | Writes |
| --- | --- | --- |
| `task-understand` | The brief's sources, the code | `brief.md`, `findings.md`, drafted questions |
| `task-plan` | Brief, findings, decisions, the code | `plan.md`, the verification plan in `verification.md`, `decisions.md` |
| `task-build` | Plan, progress | The code, `progress.md`, decisions, findings and follow-ups as they come up |
| `task-verify` | Criteria, verification plan, the diff, sources | Results in `verification.md`, files in `evidence/` |
| `task-handover` | The whole record | `pr-description.md`, drafts of follow-up issues |
| `task-changes` | `new` entries in `changes.md` | Findings, decisions, updated brief and plan, entries marked `reviewed` |

Each starts from `dev task status <id>`, describes the entries it writes from the same
definition dev parses them with, and ends by presenting its result, writing the next step in
`progress.md`, and stopping: you decide when to move on. `task-verify` runs in a fresh
context, as a subagent where the tool has them, so the work isn't graded by whoever built it.
What it can't check is marked `needs-person`, for you. Nothing is posted, pushed or opened
as a PR unless you ask.

The skills are yours to edit: like every generated file, an edited one is left alone.

## Reviewing pull and merge requests

```sh
dev github prs                 # GitHub: find and pull other people's open PRs
dev github pr 12               # pull one
dev github pr 12 --worktree    # and check it out to run or edit

dev gitlab mrs                 # GitLab: the same for merge requests
dev gitlab mr 7 --worktree
```

Each open pull request from someone else is classified against what's on disk:

| State | Meaning |
| --- | --- |
| `new` | Not pulled yet |
| `updated` | Changed since it was pulled, so any review is out of date |
| `unreviewed` | Pulled and current, with no `review.md` yet |
| `current` | Pulled and reviewed at this version |

Only new and updated ones are fetched: the description, changed files, comments, and any
tickets or specs they mention. Drafts and your own are skipped unless you ask
(`--include-drafts`, `--include-own`). Your review goes in `review.md` in its folder, and is
never touched by a sync. Merged and closed ones keep their folder, marked.

**`--worktree`** checks the pull request out in `worktrees/pr-<N>` (or `mr-<N>`) **on its own
branch**, tracking it, so changes can be pushed back. A pull request from a fork comes from the
host's special ref into a local branch named `pr-<N>`. It's never a detached commit. Open it
with `code worktrees/pr-12`.

## The working day

```sh
dev day start        # update the code, sync everything, write snapshot.md
dev day status       # is a sync running, and when was snapshot.md written
dev day end          # save the day's agent sessions, update the day summary
```

### snapshot.md

Rewritten by every `dev day start`:

- **Carried over**: the last day's Next steps and anything still blocked.
- **Tasks in flight**: each worktree's commits and uncommitted changes, how far the base has
  moved on, and what its record says needs attention: blocking findings, source changes to
  review, failed checks.
- **Reopened tasks**: finished tasks whose ticket went from done back to open, with the
  command that starts their next round.
- **Finished tasks whose sources changed**: tasks with a record but no worktree, and new
  entries in their `changes.md`.
- **A section from each service**: tickets due or overdue, in progress and to do; issues and
  board items; pull requests waiting for review; designs that changed this week.

`dev day start` fetches the code and fast-forwards the default branch only when that's safe:
never with uncommitted changes, and never when the local branch has its own commits.
`--no-sync` only rewrites the snapshot from what's on disk.

### The day summary

`dev day end` writes `work-sessions/<date>/summary.md`. Its facts (sessions, commits, task
notes changed, what changed in each service, and a link to the day's source changes) are
rebuilt every run. Its four written sections,
**What happened, Decisions, Next steps and Blocked**, are kept: fill them in. Tomorrow's
snapshot and the next session start from your Next steps.

## Working with agents

`dev` writes everything an agent needs into the workspace, for any tool:

| File | What it gives agents |
| --- | --- |
| `AGENTS.md` | The layout, the rules, every command, and each service's rules |
| `CLAUDE.md`, `.github/copilot-instructions.md` | Pointers to `AGENTS.md`, for tools that don't read it themselves |
| Skills in `.github/skills/`, `.claude/skills/`, `.agents/skills/` | Short guides: the CLI, each phase of a task, PR or MR review, reading Figma designs |
| `docs/jira.md`, `docs/confluence.md` | How each service's files are laid out, and what the Why column means |
| `.mcp.json`, `.vscode/mcp.json` | The Figma desktop app's local MCP server |
| `.github/hooks/dev.json`, `.claude/settings.json` | Session hooks for Copilot CLI and Claude Code |

The rules agents get include: read the index first; never edit synced files; never push, open a
pull request or change anything in a service unless the person asks in the session; never
handle credentials; never commit sync output; for "what are my tasks", run
`dev task list --mine`; and work on a task through its record, ending each phase by stopping.

### Session hooks

In **Copilot CLI** and **Claude Code**, hooks run on their own:

- **At session start**, the agent gets the last Next steps, the tasks in flight and what needs
  action in each (source changes to review, blocking findings), reopened tasks, what's due and what's waiting
  for review. If `snapshot.md` is more than four hours old, a `dev day start`
  starts in the background, unless a sync is already running.
- **Before each shell command and file edit**, the [command check](#the-command-check) runs.
- **At session end**, the session's transcript is saved to `work-sessions/<date>/`, with
  secrets redacted: every plugin's stored tokens, and common token shapes.

The hooks are guarded: on a machine without dev, they do nothing. Other tools can run
`dev day start` and `dev day end` by hand and lose nothing but the automatic context.
Worktrees get copies of the skills, hooks and MCP config, so agents opened there have them
too. Git ignores the copies. `dev files`, `dev add` and `dev remove` bring them up to date,
and remove a copy whose source is gone, like a removed service's skill. They only touch
copies still as dev wrote them, never a file the branch tracks; edit the workspace's own
files, not the copies.

`dev day end` also catches up on sessions that were killed before their end hook ran.
VS Code sessions aren't saved as transcripts yet.

## The command check

Before an agent runs a shell command or edits a file, the hook asks dev. dev looks only at what
it understands and decides **allow**, **ask** (the tool asks you) or **deny**:

| Kind | Examples | Default |
| --- | --- | --- |
| `read` | `gh pr view`, `gh pr diff`, `glab mr list`, `gh api` GET requests, `dev jira pull` | allow |
| `change` | `gh pr merge`, `gh pr comment`, `glab mr note`, `gh api -X POST`, a GraphQL mutation | ask |
| `config` | `dev add`, `dev remove`, `dev login`, changing a scope, any edit to `dev.yaml` or to `~/.config/dev/` | ask |
| `unknown` | gh inside `$(…)`, through `bash -c` it can't follow, an unknown extension | ask |

- Commands dev doesn't know, like `ls` or `npm test`, get no answer: your tool decides as usual.
- Help (`--help`) is always a read.
- `gh auth token` is denied by default, since it would print a token into the agent's context.
- `dev check "<command>"` shows what the check decides and why, without running anything.

Change the defaults in `~/.config/dev/policy.json`:

```json
{
  "read": "allow",
  "change": "ask",
  "config": "deny",
  "unknown": "ask",
  "commands": {
    "gh pr create": "allow",
    "gh pr merge": "deny"
  }
}
```

Each value is `allow`, `ask` or `deny`; the longest matching command wins. `"config": "deny"`
stops agents from widening what they're allowed to read. A broken policy file falls back to
the defaults; it never loosens anything.

This is a **guardrail, not a security boundary**: an agent runs as you, so a script it writes
could still reach a service or a file. It catches the ordinary case and hands the decision to
you. In Copilot's autopilot mode, every "ask" becomes a "no", because nobody is there to answer.

## Command reference

`--help` on any command shows what it does and its options. Asking for help never changes
anything.

### Setup

| Command | Does |
| --- | --- |
| `dev init [folder]` | Set up a workspace. `--versioning <service>`, `--repo <name>`, `--clone-url <url>`, `--no-clone`, `--service <services...>`, `--account <name>` |
| `dev login <plugin>` | Log in, people only. `--method <cli\|token>`, `--account <name>` |
| `dev logout <plugin>` | Remove a saved login. `--account <name>` for one account |
| `dev add <service>` | Enable a service. `--scope <yaml>` instead of choosing |
| `dev remove <service>` | Disable a service. `--delete-files` to delete its folder too |
| `dev <service> scope` | Show what a service syncs. `--choose` opens the picker; `--set <yaml>` changes it directly |
| `dev <service> scope add\|remove <items...>` | Change a list-shaped scope by link or id: Confluence pages, Notion pages, repositories, boards, Figma files |
| `dev doctor` | Check everything, with a fix for each problem. `--offline` skips login checks |
| `dev files` | Update the generated agent files, leaving hand-edited ones alone, and dev's copies in each worktree |

### Daily work

| Command | Does |
| --- | --- |
| `dev day start` | Update the code, sync, write `snapshot.md`. `--no-sync`, `--referenced` |
| `dev day status` | Whether a sync is running, and when `snapshot.md` was written |
| `dev day end` | Save sessions, update the day summary. `--date <YYYY-MM-DD>` |
| `dev sync [service]` | Sync every service, or one. `--referenced` |
| `dev index [service]` | Rebuild indexes from what's on disk |
| `dev task list` | Tasks from every task source. `--mine`, `--all`, `--refresh`, `--json` |
| `dev task start <ref>` | Worktree, branch and notes for a task; the next round for a finished one. `--title`, `--type`, `--base` |
| `dev task status [id]` | What's in flight, or one task and its record, looking up its PR. `--json` |
| `dev task diff <id>` | What a task changed since its branch left the base, uncommitted changes included. `--stat` |
| `dev task cleanup` | Which worktrees can go. `--remove` |
| `dev check "<command>"` | What the command check decides |

### Service commands

| Command | Does |
| --- | --- |
| `dev github prs` | PRs to review. `--no-pull`, `--include-drafts`, `--include-own`, `--json` |
| `dev github pr <numbers...>` | Pull PRs. `--worktree` checks each out on its branch |
| `dev gitlab mrs` | MRs to review. `--no-pull`, `--include-drafts`, `--include-own` |
| `dev gitlab mr <numbers...>` | Pull MRs. `--worktree` |
| `dev jira pull <keys...>` | Fetch tickets within the configured project boundary |
| `dev confluence pull <page>` | Fetch a page and its tree, within the scope |
| `dev github-issues pull <issues...>` | Fetch issues: `owner/repo#N`, a link, or a number |
| `dev gitlab-issues pull <issues...>` | The same for GitLab |
| `dev figma check` | Check recorded designs for changes now |
| `dev figma pull <link>` | Record a design |

### For tools

| Command | Does |
| --- | --- |
| `dev hook session-start\|session-end\|pre-tool --tool <claude\|copilot>` | Run by the session hooks |

## Environment variables

### Credentials, for scripts

`DEV_<PLUGIN>_<KEY>` overrides a stored login's value, for the default account:

| Variable | For |
| --- | --- |
| `DEV_GITHUB_TOKEN` | GitHub |
| `DEV_GITLAB_HOST`, `DEV_GITLAB_TOKEN` | GitLab |
| `DEV_ATLASSIAN_SITE`, `DEV_ATLASSIAN_EMAIL`, `DEV_ATLASSIAN_TOKEN` | Jira and Confluence |
| `DEV_NOTION_TOKEN` | Notion |
| `DEV_FIGMA_TOKEN` | Figma |

Names ending in `_URL` are settings, never credentials.

### Settings

| Variable | Default | For |
| --- | --- | --- |
| `XDG_CONFIG_HOME` | `~/.config` | Where `dev/` keeps logins and the policy |
| `DEV_GITHUB_API_URL`, `DEV_GITHUB_WEB_URL` | `https://api.github.com`, `https://github.com` | Another GitHub server |
| `DEV_FIGMA_API_URL` | `https://api.figma.com` | Figma's API |
| `DEV_FIGMA_MCP_URL` | `http://127.0.0.1:3845/mcp` | Figma desktop's MCP server |
| `DEV_NOTION_API_URL` | `https://api.notion.com` | Notion's API |
| `CLAUDE_CONFIG_DIR`, `COPILOT_HOME` | `~/.claude`, `~/.copilot` | Where to find session transcripts |
| `DEV_EXTRA_PLUGINS` | | Plugin modules to load, for developing plugins |
| `DEV_DEBUG` | | Show stack traces for unexpected errors |
| `DEV_PROGRESS` | | `plain` for plain progress lines, even at a terminal. See [Progress](#progress) |
| `DEV_PROMPTS` | | `classic` for init's usual prompts, and plain progress lines |

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "This isn't a dev workspace" | Run the command inside one, or create one with `dev init` |
| "You're not logged in to …" | Run `dev login <plugin>` yourself |
| "… rejected the saved login" | The token expired or was revoked: `dev login <plugin>` again |
| `dev: permission denied` after rebuilding from source | Run `npm run build` again: it marks the command executable |
| "This needs an answer, and there's no terminal to ask in" | Pass the flag it names instead |
| A Confluence sync reports failed pages | Run it again. The old copy stays until every page in the tree succeeds |
| "A sync is already running" | `dev day status` says which, and since when. A killed one's lock is taken over by the next sync; only an unreadable lock needs `dev sync --recover` |
| Linked items "outside the scope, so not fetched" | `dev <service> scope add <link>`, or set `fetch: anywhere` for that service |
| GitHub Projects: "can't read projects" | `gh auth refresh -s read:project`, or a token with that scope |
| Notion: "can't find that page" | Connect the integration to the page: its ... menu > Connections |
| Figma: designs "not checked" | Open the listed file in Figma desktop and run `dev figma check`, or `dev login figma` |
| An agent says a command was declined | `dev check "<command>"` shows whether dev asked or denied it. If dev has no opinion, your tool declined it |
| A generated file "was edited by hand" | dev leaves it alone. Delete it and run `dev files` to get the current version |
| Anything else | `dev doctor` |

## Development

```sh
npm install
npm test             # every test, with fake services: nothing reaches a real one
npm run typecheck
npm run build        # compiles to dist/
```

- `src/cli.ts` is the entry point. `src/program.ts` builds the command tree, from which
  `AGENTS.md` and the skills' command tables are generated.
- `src/core/` holds what every plugin shares: config, credentials, front matter, indexes,
  scaffolding, worktrees, the day, sessions, the command check and reference following.
- `src/plugins/<name>/` holds each plugin. `src/plugins/types.ts` is the plugin interface.
- `templates/workspace/` holds the generated files' templates.
- `test/` runs each feature against temporary folders, a temporary config home, fake service
  APIs and an example plugin in `test/fixtures/`.
- `docs/design.md` is the full design, including what each phase taught the interface.

TypeScript runs directly in development (Node strips the types), and is compiled for the
package.

## Writing a plugin

A plugin is a module whose default export is a `Plugin` (see `src/plugins/types.ts`):

```ts
const plugin: Plugin = {
  name: "acme",                    // used in "acme:<service>" and "dev login acme"
  title: "Acme",
  description: "Acme's tracker",
  login: { methods: [{ kind: "token", title: "API token" }], login, check },
  secrets: (credentials) => [credentials.token ?? ""],   // redacted from saved sessions
  services: [{
    id: "acme-tickets",            // unique; the folder and the command name
    title: "Acme tickets",
    description: "Tickets, one folder per ticket",
    role: "connected",
    scope: { describe, choose, validate },
    sync,                          // write items with writeItem(), then buildIndex();
                                   // context.progress("12 of 40 tickets") as it goes
    tasks: { list },               // if it holds work
    links: { find, fetch },        // recognise and fetch its own references
    contribute: { snapshot, sessionStart, dayEnd, taskStart },
    commands: [/* dev acme-tickets <name>, each marked read or change */],
    agentFiles: { skills, docs, rules, gitignore, mcp },
  }],
};
export default plugin;
```

Only `id`, `title`, `description`, `role` and `scope` are required: a service implements the
capabilities that apply to it. Load a plugin under development with
`DEV_EXTRA_PLUGINS=/path/to/plugin.ts dev …`. It runs with your credentials, like any plugin.

Built-in plugins are registered in `src/plugins/registry.ts`.

## Licence

MIT. See [LICENSE](LICENSE).

The next sync takes over a lock left by a dead process; an unreadable lock needs `dev sync --recover`. Status checks never delete a lock. Bare `dev <service> scope` only displays the scope; use `--choose` for the interactive picker.

### Release verification

`npm run typecheck` checks both source and tests. `npm run test:package` builds a tarball,
installs it in a temporary folder, and verifies the installed CLI and workspace templates.
CI runs the checks on Linux and macOS, including Node 22.13. The development/test commands
explicitly enable Node's TypeScript stripping for older supported runtimes.

Transcripts are exported only when a session hook recorded matching provenance on this
machine. That local provenance is stored outside the workspace, so a committed session
reference alone cannot request another local transcript. Rewriting history or cloning a
workspace does not import another machine's transcript-export permission.

Task names transformed into folder names include a short identity hash; issue task IDs
also include their source service. Use the worktree/notes paths printed by `dev task start`.
For ambiguous issue references, prefix the service, for example
`dev task start github-issues:acme/web#42`.
