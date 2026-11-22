---
name: "dev-cli"
description: "Find and run the dev command for syncing services, starting a task, or checking the workspace. Use whenever a task needs fresh data or you're unsure which command does something."
---

# Using the dev CLI

`dev` is this workspace's automation. Run it from anywhere inside the workspace.

## Which command

| You want to | Run |
| --- | --- |
{{commands}}

For options, run the command with `--help`. This changes nothing and works anywhere.

## Rules

- For "what are my tasks?", run `dev task list --mine`. It says when the data was synced.
- Never run `dev login` or ask for credentials. If a login is missing, ask the person.
- Never commit sync output. Summarise what changed and leave it for the person.
- Commands marked as changing a service need the person's go-ahead in this conversation.
