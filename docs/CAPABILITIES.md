# Capabilities: what is built, and what has been verified

"Tested" means an automated test in this repo passes. "Not verified" means no test or run has exercised it against the real service.

| Claim | Status | Evidence / gap |
|---|---|---|
| Edits across the project, linter-aware fixes, diffs, checkpoints, one-click undo | Built | Verify-fix loop on LSP diagnostics, diff review, checkpoints and undo have unit and real-window e2e tests. Python language-server path untested. |
| Plan then Act, approve each step or auto-approve | Built | Mode toggle and approval flow covered by e2e. |
| Every model: Claude, GPT, Gemini, Ollama, LM Studio, any OpenAI-compatible endpoint, own key or weights | Partly verified | Ollama measured live (qwen2.5-coder 1.5b/7b); OpenAI-compatible and Anthropic wire formats tested against mock servers. Claude on a Pro plan goes through the Claude Code client over ACP (built; the official client is the only path without an API key). **Gemini, OpenRouter, Groq, LM Studio are presets** (`--provider gemini` etc. in the CLI) that point the OpenAI-compatible client at their endpoints, with each preset reading its own key variable. **Never run against those real services.** Desktop Settings has no preset picker yet: use "OpenAI-compatible" and enter the URL. |
| Runs bash, reacts to output live, long-running commands | Built | Command tool with permission prompts, streaming output; covered by tests. |
| Rules and Skills; `.forgerules` shipped with the repo | Built | `.forgerules`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules` and others are loaded in the app **and** the CLI; scoped rules in `.forge/rules`. Tested. |
| MCP and plugins; custom tools and hooks | Built, no separate SDK | See [EXTENDING.md](EXTENDING.md). MCP client, skills with declared scripts, `.forge/hooks.json`. |
| Slack / Discord / Telegram / Linear chat | **Not built** | Only the foundation exists: `forge-code serve` (read-only authenticated `POST /ask`, tested). An adapter that verifies Slack signatures, long-polls Telegram, or receives Linear webhooks is not written. |
| Headless in GitHub Actions / GitLab / any pipeline | Built, CI run not verified | `forge-code ask/run --json`, exit codes, `--apply`. The bundled CLI is tested as a process against a mock server. [Example workflow](examples/github-actions.yml) has never run on a real runner. |
| Multi-agent teams | Built, read-only specialists | `.forge/agents/*.md` define specialists (instructions, tools, model tier) the coordinator calls with `delegate`. Specialists only get read tools, by design. Not available in the CLI yet. |
| Cron schedules | Built | `forge-code schedule` (list, run-due, run, watch), cron parsing tested including clock changes. Needs something to call it (cron, Task Scheduler, CI) or `watch`. |

Other unverified items: real Anthropic prompt-cache savings (one-command check provided, never run), hosted-provider behaviour, Unity/Blender integrations.
