# Using Claude with your Claude plan (no API key)

A Claude Pro or Max subscription does not come with an API key, and Anthropic does not allow other apps to use a subscription login directly.
What it does include is Claude Code, Anthropic's own coding client. Forge-Code can drive Claude Code, so you get Claude in Forge on your plan.

## Set it up (once)

1. Install Claude Code (claude.com/product/claude-code).
2. Sign in with your Claude account: open a terminal, run `claude`, and use the `/login` command.
3. Open Forge-Code and a folder. In **Settings > Claude plan**, the status should say "Signed in with your Claude plan". If you signed in after opening
   Forge, press **Check again**.
4. In the mode list at the top of the agent panel, choose **Claude plan**, and send a message as usual.

The first time, Forge asks before it starts Claude Code ("Start external agent claude"). Nothing about your login passes through Forge: it only asks
Claude Code whether it is signed in (`claude auth status`).

## What you get

- Claude working in your project: it reads files and proposes edits, **every edit goes to the review pane** where you accept or reject it, and anything
  that runs a command or reads outside the project asks you first. Forge's denylist for secrets and dangerous commands applies.
- Your plan's limits and billing, not the Max $ setting (that one only counts API usage).

## What is different from Forge's own agent

- **It is Claude Code's loop, not Forge's.** Forge's model routing (scout/builder/architect), options-before-code, the verification loop after edits, and
  the token meter do not apply to it. Edits still arrive through review, and "Run checks" still works on what you accept.
- **Your code goes to Anthropic.** The privacy badge says "remote" while Claude is selected, and **local-only mode hides it** (Claude cannot run locally).
- Claude Code is a separate program with its own settings and updates.

## If it does not work

- *"Claude Code is not installed"*: install it and press Check again. If it is installed but not found, make sure `claude` runs in a normal terminal.
- *"installed but not signed in"*: run `claude` in a terminal and use `/login`.
- A login with an API key or a cloud provider (not a claude.ai login) is still offered, but Settings warns that it bills that account.
- Your own `.forge/acp.json` can define an agent named `claude` (for example to pin a version); it replaces the built-in one.

## Verified

On the development machine (signed in with a Claude plan, no API key): `npx vitest run packages/acp/test/live.test.ts` with `FORGE_LIVE_ACP=1` started the
adapter, Claude read a file and tried an edit, Forge captured the edit as a pending proposal with nothing written to disk, and Claude answered. The mode
list, status line, "remote" badge and local-only hiding are tested in the real window (`claude-plan.spec.ts`). A full interactive session through the
panel with a real Claude was not recorded.
