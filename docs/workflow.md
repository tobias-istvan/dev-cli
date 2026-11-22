# dev: the task workflow

How a task is understood, planned, built, verified and handed over, by a person or an agent,
with everything recorded in the workspace so anyone can pick it up later.

[design.md](design.md) covers what exists: the workspace, plugins, syncing and the command
check. This document covers what comes next, on top of it.

Status: built in 0.4. The build order is at the end.

## The problem

The information a task needs is scattered across trackers, docs, designs and code. dev
already gathers it into local files. With agents doing more of the work, gathering isn't
enough:

- **Discovery.** Tickets are incomplete, sources disagree (the ticket, the spec, the design and
  the code itself) and requirements are missing. Someone has to find that and write it down,
  for the developer and for the next agent.
- **Guidance.** Agents need to be steered through planning and building, not handed a ticket.
- **Verification.** The work has to be shown to meet what was asked, with evidence, against
  a plan made before the build.
- **Change.** Requirements and designs change during and after implementation. The
  developer needs to see what changed and which work it affects.
- **Persistence.** All of it lives in files, so any agent, any session, any day can carry on.

## Principles

1. **The unit is the task**: one ticket. Refinement, discovery work across tickets and
   estimation come later.
2. **Everything is a file in the workspace**, readable by people and agents, and kept.
3. **The developer is the reader.** Agents read the same files, and act for the developer
   when the developer gives them the tools to.
4. **Enablement, not enforcement.** dev reports state: open findings, unverified criteria,
   sources that changed. It never blocks work.
5. **Skills do the thinking; the CLI keeps the books.** Skills discover, plan and verify.
   The CLI records changes, works out each task's state and reports it.
6. **Small, editable skills.** Each skill is short, does one phase, and is the person's to
   edit, like every generated file.

## Phases

| Phase | dev today | What's added |
| --- | --- | --- |
| Orient | `dev day start`, `snapshot.md`, `dev task list --mine` | Tasks whose sources changed, reopened tasks |
| Gather | `dev task start`: worktree, branch, brief, linked sources | The task's sources recorded in the brief's front matter |
| Understand | An empty brief | `task-understand`: brief filled in, findings recorded |
| Plan | Nothing | `task-plan`: approach, verification plan, decisions |
| Build | `progress.md` | `task-build`: progress, decisions, findings and follow-ups as they come up |
| Verify | Nothing for your own work | `task-verify`: evidence for each criterion |
| Hand over | `pr-description.md`, `dev day end` | `task-handover`: PR description, drafts of questions and follow-up issues |
| Any time | `dev sync` counts what changed | Change report, and changes recorded in each task they affect |

## The task record

`tasks/<id>/` holds the whole task. Some files are **state**: rewritten as understanding
improves. Others are **logs**: entries are added and their status updated, never removed.

| File | Kind | Written by | Holds |
| --- | --- | --- | --- |
| `brief.md` | state | `dev task start`, then `task-understand` | What we're building, acceptance criteria, scope. The entry point: links to everything else |
| `findings.md` | log | `task-understand`, `task-build` | Gaps, conflicts and missing information |
| `decisions.md` | log | any phase | Choices made, why, the alternatives, and the findings they resolve |
| `plan.md` | state | `task-plan` | Approach and steps |
| `verification.md` | log | `task-plan`, then `task-verify` | For each criterion: how it's checked, by whom, the evidence expected, then the result |
| `evidence/` | files | `task-verify` | Screenshots, logs and test output that `verification.md` links to |
| `changes.md` | log | `dev sync`, then `task-changes` | Source changes that affect this task |
| `follow-ups.md` | log | any phase | Issues found but not fixed in this task |
| `progress.md` | state | any phase | Done and next step: the handoff between sessions |
| `pr-description.md` | state | `task-handover` | As today |
| `history/<n>/` | files | `dev task start` | Earlier rounds' per-PR files. See [Rounds](#rounds) |

Session transcripts stay in `work-sessions/`, tagged with the task. The record links to
them and doesn't copy them.

### Entries

Every log uses one shape: a heading with an id, a kind where there is one, and a status,
then fields as a list, then free text.

```markdown
## F3 · conflict · open

- Sources: jira/ABC-123/ticket.md (Acceptance criteria), figma/abc-12-34/design.md
- Blocks: yes
- Answer from: the ticket's reporter

The ticket sorts the list by date; the design sorts it by name.
```

| Log | Id | Kinds | Statuses |
| --- | --- | --- | --- |
| `findings.md` | `F1`… | `gap`, `conflict`, `missing` | `open`, `answered`, `assumed` |
| `decisions.md` | `D1`… | – | – (fields: Resolves, Why, Alternatives) |
| `verification.md` | `V1`… | the criterion it checks | `planned`, `passed`, `failed`, `needs-person` |
| `changes.md` | `C1`… | the source's service | `new`, `reviewed` (field: Led to) |
| `follow-ups.md` | `O1`… | – | `noted`, `filed` (field: Filed as) |

Ids are never reused, so entries can refer to each other ("resolves F3", "led to D5"). An
`assumed` finding has a decision that states the assumption.

The formats are defined once in the code. The generated skills describe them from that
definition and dev parses them with it, so the two can't drift.

### Writing and reading the record

- **Agents write the files directly**, with any tool. There are no commands for adding
  entries.
- **dev parses them and works out the state**: open and blocking findings, unreviewed
  changes, criteria not yet verified. There's no separate status file to drift.
- **A malformed entry is a warning**, in `dev task status` and `dev doctor`, never an error.
- **Task folders from before this format are left as they are.** dev reads both shapes; a
  skill moves an old brief's open questions into `findings.md` when it next works on the
  task.

### The brief's front matter

```yaml
---
id: "ABC-123"
title: "Sort the order list"
branch: "feature/ABC-123-sort-the-order-list"
base: "main"                   # recorded since 0.4; status and cleanup compare with it
worktree: "worktrees/ABC-123"
round: 1
pr: 42
finished: "2026-11-20"         # the day the PR merged; set by dev
sources:                       # only what the link graph can't find; see below
  - confluence/DOCS/Ordering/index.md
---
```

`pr` is filled in by dev once it finds the task's pull or merge request, and `finished` once
that merged: in `dev task status <id>`, `dev day start` and `dev task cleanup`. A task
cleaned up with no merged PR found is finished the day its worktree was removed.

## Rounds

One task is one ticket and one folder, with one PR at a time. When a ticket is reopened
after its PR was merged, the task gets a new round instead of a new folder:

- **Logs carry on:** findings, decisions, changes and follow-ups keep their history.
- **Per-PR files start again:** `pr-description.md` and the results in `verification.md`
  move to `history/<n>/`. The verification plan stays, so every criterion is checked again,
  not only the new ones.
- **`brief.md` and `plan.md` are updated in place**; why is in `changes.md` and
  `decisions.md`.
- **A new branch and worktree with a suffix**, like `feature/ABC-123-sort-the-order-list-2`.
- **Agents read the top-level files**, which always describe the current round.

`dev task start` on a finished task starts the next round, once the last round's worktree is
removed. The round's files go to `history/<n>/` with a `README.md` naming its PR, merge date
and branch. A task with one PR never sees any of this.

A reopen is noticed as a source change: the task's own ticket goes from done back to open.
Each task source already says which of its items are done; the sync keeps that in its
baseline, and marks the task's entry `Reopened: yes`. The snapshot and session start say so.
New comments on a finished ticket are recorded as a change, not as a reopen.

## Source changes

### What a sync records

dev keeps every synced item as the last finished sync left it, in `.dev/state/items.json`:
its file, `updated`, front matter, a hash of each body section and its comment count. At the
end of each sync, once links point at the local copies, dev compares the files with that
baseline, records the differences and moves the baseline on. That's the same baseline a
commit before the sync would give, so nobody needs to commit to see what changed. dev never
commits.

Comparing at the end, rather than as each file is written, covers every way a plugin writes:
staged page trees, renames, link rewrites. A sync that's interrupted loses nothing, since the
next one compares with the same baseline. The first sync after upgrading only sets it.

A change is recorded when:

- an item is added, leaves the scope, is deleted in the service, leaves the workspace, or
  moves (a move is one change, not a removal and an addition)
- a front matter field changes: status, assignee, priority, title, parent, or a service's own
  fields
- a section of the body changes, named by its heading
- comments are added: every task source writes a `Comments (N)` heading, so a bigger N is
  new comments, without each plugin's help

A file that changed while its `updated` didn't is dev rendering it differently, not a change
in the source, and isn't recorded. Without that, upgrading dev would look like every
requirement changed. Moves, scope changes, deletions and new comments are recorded either
way, since they don't always move `updated`.

Limits, the same as with git: between two syncs, only the net change is seen.

### The change report

Each sync that changed something adds a section to `work-sessions/<date>/changes.md`. Each
entry names the item, what changed, and the tasks it affects, with the id of each task's
entry. The day summary links to it.

### Which tasks a change affects

A task's sources are worked out on every sync from what dev already knows: the files the
brief's Sources section links to (the ticket and what it links to, from `dev task start`),
the item with the task's id, and one step further from those: their parent, their `links`
and what their bodies link to locally. The brief's `sources:` adds what
the link graph can't see. Agents add to it when they find a source that matters; usually it's
empty.

A change to any of a task's sources is added to that task's `changes.md` as a `new` entry,
for every task folder, finished ones included for `conventions.watchDays` (30 by default)
after their `finished` date. After that, the day's change report still lists the change. A
change to a finished task's ticket is how a reopen shows up.

### Picking it up

- `dev task status`, the snapshot and the session-start hook report unreviewed changes.
- `task-changes` reads the new entries, works out what they mean for the brief, plan and
  verification plan, records findings or decisions, updates the files, and marks each entry
  `reviewed` with what it led to.

## Skills

Each skill says what it reads, what it writes, which entry formats it uses and which `dev`
commands it runs. They're generated into `.github/skills/`, `.claude/skills/` and
`.agents/skills/`, like today's, and left alone once edited.

| Skill | Reads | Writes |
| --- | --- | --- |
| `dev-cli` | – | – (exists) |
| `task-understand` | The brief's sources, the code | `brief.md`, `findings.md` |
| `task-plan` | Brief, findings, decisions, the code | `plan.md`, `verification.md` (the plan), `decisions.md` |
| `task-build` | Plan, progress | `progress.md`, `decisions.md`, `findings.md`, `follow-ups.md` |
| `task-verify` | Criteria, verification plan, the diff, sources | `verification.md` (results), `evidence/` |
| `task-handover` | The whole record | `pr-description.md`, drafts of questions and follow-up issues to post |
| `task-changes` | New entries in `changes.md`, the record | Findings, decisions, updated state files, entries marked `reviewed` |
| `pr-review` | – | – (exists, for other people's PRs) |

- **Every skill can be picked up by the agent**, since not every tool supports skills that
  only the person can start.
- **Each phase skill ends by presenting its result, writing the next step in
  `progress.md`, and stopping.** The developer decides when to move to the next phase. A tool
  that can't stop and wait still leaves the next step where the next session finds it.
- **`task-build` is a skill, with a rule in `AGENTS.md`** to keep the record current
  whichever way the work is done, so guidance doesn't depend on an agent picking the skill up.
- **The entry formats in each skill are generated** from the definitions dev parses with, and
  the workspace's `conventions.checks`, when set, are written into the skills that run them.
- **`task-verify` runs in a fresh context**, as a subagent where the tool has them, so it
  doesn't grade its own build. It follows the verification plan; what it can't check is
  marked `needs-person`, for the developer.
- **Discovery output is written for the developer**, who decides what to do with it. A
  question for the ticket's owner is drafted so it can be posted as written, by the
  developer or by an agent they've given that tool. dev doesn't post it.
- **A follow-up's draft says where it was found** ("Found while working on ABC-123"), so the
  issue links back to the task once filed. When it syncs in, its link connects the two
  locally.

## CLI

| Part | Change |
| --- | --- |
| `dev sync` | Records changes as it writes; writes the change report; adds entries to each affected task |
| `dev task status [id]` | Adds the record's state to today's git state: open and blocking findings, unreviewed changes, unverified criteria, round, PR state, malformed entries. `--json` for tools |
| `dev task start` | Writes `sources:`, `round` and `pr` into the brief; starts a new round when the PR is merged |
| Session-start hook | Only what needs action now: reopened tasks, unreviewed changes on tasks in progress, blocking findings |
| `snapshot.md` | Tasks with changed sources, reopened tasks |
| `dev day end` | Links the day's change report |
| `dev doctor` | Reports malformed record entries |
| Versioning services | Built in 0.4 for `dev task cleanup` (issue #7): `changeRequests`, the pull or merge requests for a branch, newest first, with their state |

**How to check the code.** Verification needs the repository's test, lint and build
commands. Skills find them in the repository's own `AGENTS.md`, scripts and CI config. An
optional `conventions.checks` in `dev.yaml` overrides them:

```yaml
conventions:
  checks:
    test: npm test
    lint: npm run lint
```

## Build order

Each step is useful on its own.

1. **Change records** (built in 0.4). Record changes during sync, the `updated` rule, the change report,
   each task's sources from the link graph, and `changes.md` in each affected task. Done
   when a sync after a ticket edit says what changed and which tasks it affects, with no
   commit.
2. **The task record** (built in 0.4). Entry formats defined once, the parser, `dev task status` with the
   record's state, the brief's new front matter, warnings in `dev doctor`, reading old
   briefs. Done when `dev task status ABC-123` reports a hand-written record correctly.
3. **Skills** (built in 0.4). `task-understand`, then `task-plan` with the verification plan, then
   `task-verify`, then `task-changes`. `task-build` and `task-handover` last. The
   session-start hook and snapshot lines arrive with them.
4. **Rounds** (built in 0.4). Finding the task's PR, reopen detection, `history/<n>/`, and
   the round in `dev task start`.

## Decided

- **Which finished tasks keep watching their sources:** each for `conventions.watchDays`
  after it finished, 30 by default.
- **How long change reports are kept:** indefinitely. They're small, and they're the
  record of why work changed.
