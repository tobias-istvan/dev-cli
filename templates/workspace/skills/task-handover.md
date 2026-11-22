---
name: "task-handover"
description: "Prepare a finished task to hand over: the PR description, and drafts of questions and follow-up issues for the developer to post. Use when a task is built and verified, or when asked for the PR description."
---

# Handing over a task

Reads the whole record in `tasks/<id>/`. Writes `pr-description.md`, and drafts in
`findings.md` and `follow-ups.md`.
Paths are from the workspace root: two folders up from a task's worktree.

1. Run `dev task status <id>`. List anything still open first: open findings, failed
   checks or ones that need a person, source changes not reviewed. The developer decides
   whether to hand over anyway.
2. Write `pr-description.md`. Follow the repository's PR template if it has one, like
   `repository/.github/PULL_REQUEST_TEMPLATE.md`, with the same headings. Otherwise say
   what changed and why, and how it was tested, linking the evidence where it helps.
   `dev task diff <id> --stat` lists what changed. Leave
   any checkboxes unticked: they're the author's own statements. From round 2, say what
   this PR changes since the last one: the earlier description is in
   `tasks/<id>/history/<n>/pr-description.md`, and why it's back is in `changes.md`.
3. For each `noted` follow-up, draft the issue in its free text so it can be filed as
   written: a title, what's wrong and where, and "Found while working on <id>".
4. For each open finding someone else has to answer, check its drafted question is still
   right.
5. Once the developer has filed a follow-up, mark it `filed` with `Filed as`.

{{format:follow-ups}}

Then stop. Present the PR description and the drafts, and write the next step under
"Next step" in `tasks/<id>/progress.md`. Pushing, opening the PR and posting anything are
the developer's call: do them only when asked in this conversation.
