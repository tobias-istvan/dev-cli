---
name: task-understand
description: Understand a task before planning it: fill in its brief from the sources, and record gaps, conflicts and missing information as findings. Use after "dev task start", or when asked to understand, discover or refine a task.
---

# Understanding a task

Reads the brief's sources and the code. Writes `brief.md` and `findings.md` in
`tasks/<id>/`. The id is the one the person gives, or the task whose worktree you're in.

1. Run `dev task status <id>`, then read `tasks/<id>/brief.md`.
2. Read each source the brief links to, and each file its `sources:` lists. Follow their
   links further only when they matter. Read the code the task touches, in
   `worktrees/<id>/`.
3. Fill in the brief: what we're building, the acceptance criteria as a checklist, the
   constraints, and what's out of scope. Write it from the sources, not from guesses, short
   enough for the developer to read in a minute. Keep the Sources section. A workspace file
   that matters but that no link reaches goes in the front matter's `sources:`.
4. Record each gap, conflict or missing piece in `findings.md` as you find it: where it was
   found, whether it blocks the work, and who can answer it. A brief with an "Open questions"
   section from before `findings.md`: move each question there as an `open` finding, and
   replace the section with a link to `findings.md`.
5. For each finding someone else has to answer, draft the question in the finding's free
   text, so it can be posted as written: who it's for, the question, and why it matters.
   Don't post it.

{{format:findings}}

Then stop. Present the brief in a few lines, the blocking findings first, then the drafted
questions. Write the next step under "Next step" in `tasks/<id>/progress.md`: usually,
answer the blocking findings, then plan with `task-plan`. The developer decides when to
move on.
