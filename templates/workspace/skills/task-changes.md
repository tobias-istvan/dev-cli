---
name: task-changes
description: Work out what changed sources mean for a task, and update its record. Use when dev task status, the snapshot or the session start reports source changes to review.
---

# Reviewing source changes

Reads the `new` entries in `changes.md` and the record. Writes findings, decisions and the
state files in `tasks/<id>/`, and marks each entry `reviewed`.

1. Run `dev task status <id>` for the changes to review. Read each `new` entry in
   `tasks/<id>/changes.md`, and the item it names. The change report it links has the sync's
   other changes.
2. For each, work out what it means for the task: nothing; an update to the brief, plan or
   verification plan; a new finding; or the answer to an open finding, which then becomes
   `answered`, with its `Answer`.
3. Update `brief.md`, `plan.md` and `verification.md` in place, and record why as findings
   or decisions. A criterion that changed is checked again: set its verification entry back
   to `planned`.
4. Mark each entry `reviewed`, with `Led to:` naming the findings and decisions it led to,
   or `nothing`.
5. A finished task's ticket moving back to an open status, or getting new comments, may mean
   it was reopened. Tell the developer.

{{format:changes}}

Then stop. Present what changed for the task, and write the next step under "Next step" in
`tasks/<id>/progress.md`.
