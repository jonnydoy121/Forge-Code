# Capabilities: what is built, and what has been verified

"Tested" means an automated test in this repo passes. "Not verified" means no test or run has exercised it against the real service.

| Claim | Status | Evidence / gap |
|---|---|---|
| Edits across the project, linter-aware fixes, diffs, checkpoints, one-click undo | Built | Verify-fix loop on LSP diagnostics, diff review, checkpoints and undo have unit and real-window e2e tests. Python language-server path untested. |
| Plan then Act, approve each step or auto-approve | Built | Mode toggle and approval flow covered by e2e. |
| Every model: Claude, GPT, Gemini, Ollama, LM Studio, any OpenAI-compatible endpoint, own key or weights | Partly verified | Ollama measured live (qwen2.5-coder 1.5b/7b); OpenAI-compatible and Anthropic wire formats tested against mock servers. Claude on a Pro plan goes through the Claude Code client over ACP (the only keyless path). **Gemini, OpenRouter, Groq and LM Studio are presets** in the CLI (`--provider gemini`) and in Settings (an Endpoint picker under OpenAI-compatible; switching clears the shared key so one service's key is never sent to another; e2e-tested). **Never run against those real services.** |
| Runs bash, reacts to output live, long-running commands | Built | Command tool with permission prompts, streaming output; covered by tests. |
| Rules and Skills; `.forgerules` shipped with the repo | Built | `.forgerules`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules` and others are loaded in the app **and** the CLI; scoped rules in `.forge/rules`. Tested. |
| MCP and plugins; custom tools and hooks via an SDK | Built | `@forge/sdk` (`packages/sdk`): `defineTool` / `runTool` / `toolsManifest` for skill tools and `runHook` / `hookInput` for lifecycle hooks, tested as real processes against the real argument and exit-code protocol. It is a workspace package, not published to npm. MCP client and `.forge/hooks.json` as before. See [EXTENDING.md](EXTENDING.md). |
| Chat from Slack / Discord / Telegram / Linear | Built, mock-tested only | `forge-code serve`: Slack slash command (signing-secret check, 5-minute replay window, reply only to hooks.slack.com), Discord interactions (Ed25519), Linear comment webhook (HMAC; "@forge" trigger, replies as a comment), Telegram long polling (only listed chat ids). Read-only questions. Signature checks are mutation-tested. **Never run against the live services**, and none is reachable from the internet without a tunnel you set up. Only questions: no edits or commands from chat. |
| Headless in GitHub Actions / GitLab / any pipeline | Built, CI run not verified | `forge-code ask/run --json`, exit codes, `--apply`. The bundled CLI is tested as a process against a mock server. [Example workflow](examples/github-actions.yml) has never run on a real runner. |
| Multi-agent teams | Built, read-only specialists | `.forge/agents/*.md` define specialists (instructions, tools, model tier) that the coordinator calls with `delegate`, in the app and the CLI (the CLI has no model tiers, so `tier` is ignored there). Specialists only get read tools, by design. |
| Cron schedules | Built | `forge-code schedule` (list, run-due, run, watch), cron parsing tested including clock changes. Needs something to call it (cron, Task Scheduler, CI) or `watch`. |

Skills are applied automatically when a request clearly matches them; see [AUTO-SKILLS.md](AUTO-SKILLS.md) for the research, measurements and limits (one small local model, not hosted models). Personas are not switched automatically.

Other unverified items: real Anthropic prompt-cache savings (one-command check provided, never run), hosted-provider behaviour, Unity/Blender integrations.
