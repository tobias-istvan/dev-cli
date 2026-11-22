---
name: "task-verify"
description: "Check a task's work against its verification plan, in a fresh context, and record the result and evidence for each criterion. Use when a task is built, or when asked to verify or test it."
---

# Verifying a task

Reads the acceptance criteria, `verification.md`, the diff and the sources. Writes the
results in `verification.md` and evidence in `evidence/`, in `tasks/<id>/`.
Paths are from the workspace root: two folders up from a task's worktree.

Run this in a fresh context, so the work isn't graded by whoever built it: as a subagent
if your tool has them, otherwise in a new session. Record what you find; don't fix it here.

1. Run `dev task status <id>`. Read the brief's acceptance criteria and `verification.md`.
   With no verification plan, say so and stop: planning it is `task-plan`'s job.
2. Read what the task changed with `dev task diff <id>`: everything since its branch left
   the base, uncommitted changes included, and the new files git doesn't track yet. Read the
   sources the criteria come from.
3. Run the checks:

{{checks}}

4. For each entry, do what its How says, then set its status: `passed` with the evidence,
   `failed` with what happened, or `needs-person` with what the developer should look at,
   when only a person can judge it. Save screenshots, logs and test output in
   `tasks/<id>/evidence/` and link them from `Evidence`.
5. A criterion with no entry: add one and check it. From round 2, every entry starts as
   `planned` again: check them all, not only the new ones. The last round's results are in
   `tasks/<id>/history/<n>/verification.md`.
6. A problem no criterion covers: a finding, or a follow-up if it isn't this task's.

{{format:verification}}

Then stop. Present the results, failures first, then what needs a person. Write the next
step under "Next step" in `tasks/<id>/progress.md`: fixing the failures with `task-build`, or
handing over with `task-handover`.
