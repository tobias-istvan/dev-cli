---
name: task-plan
description: Plan a task once it's understood: the approach and steps, a verification plan for each acceptance criterion, and the decisions behind them. Use after task-understand, or when asked to plan a task.
---

# Planning a task

Reads the brief, findings, decisions and the code. Writes `plan.md`, `verification.md` and
`decisions.md` in `tasks/<id>/`.

1. Run `dev task status <id>`. If a finding blocks the work, say so and stop. If the person
   says to plan anyway, record each assumption: mark the finding `assumed`, and add a
   decision that states the assumption and resolves it.
2. Read the brief, `findings.md`, `decisions.md`, and the code the task touches in
   `worktrees/<id>/`.
3. Write `plan.md`: the approach in a paragraph, then the steps, each small enough to finish
   and check on its own, with the files it changes. When there's a real choice between
   approaches, record it as a decision.
4. Write the verification plan in `verification.md`: one `planned` entry for each acceptance
   criterion, saying how it's checked, by what or whom, and the evidence expected. Prefer
   checks that can be run: tests first, then the running app. What only a person can judge,
   like a match with the design, is `By: a person`. Entries already there stay; add entries
   only for criteria that have none.
5. The checks the plan can use:

{{checks}}

{{format:verification}}

{{format:decisions}}

Then stop. Present the approach, the steps and the verification plan, and wait for the
developer's approval. Write the next step under "Next step" in `tasks/<id>/progress.md`.
