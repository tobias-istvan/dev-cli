---
name: "task-build"
description: "Build a planned task step by step, keeping its record current: progress, decisions, findings and follow-ups as they come up. Use when asked to build, implement or continue a task."
---

# Building a task

Reads `plan.md` and `progress.md`. Writes `progress.md`, `decisions.md`, `findings.md` and
`follow-ups.md` in `tasks/<id>/`, and the code in `worktrees/<id>/`.
Paths are from the workspace root: two folders up from a task's worktree.

1. Run `dev task status <id>`. Read `plan.md` and `progress.md`, and start from its
   "Next step". If source changes are waiting to be reviewed, say so first: the plan may be
   out of date.
2. Work through the plan's steps in `worktrees/<id>/`, running the checks as you go:

{{checks}}

3. Keep the record as you go, not at the end:
   - `progress.md`: what's done and the next step, after each step and before stopping for
     any reason.
   - A choice the plan didn't make: a decision.
   - Something the sources don't answer: a finding. If it blocks, stop and ask.
   - Something wrong that isn't this task's to fix: a follow-up, saying where you found it.
   - A change to the plan: update `plan.md`, and record why as a decision.
4. Commit each step that works, in the worktree, unless the person prefers otherwise.
   Never push.

{{format:decisions}}

{{format:findings}}

{{format:follow-ups}}

When the plan's steps are done, or you have to stop, present what's done and the next step,
and stop. Checking the work against the criteria is `task-verify`'s job, in a fresh context.
