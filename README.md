# Forge-Code

An AI-native desktop code editor where the agent is first-class and **you stay in control**: every change is a diff you
review, everything is reversible, and your code stays on your machine unless you choose otherwise.

## Why Forge-Code
- **Review by default.** Agent edits arrive as pending changes with per-hunk accept/reject and a reason for each hunk.
  This includes edits from external agents (Claude Code, Gemini CLI, Codex) connected over ACP.
- **Private and provable.** Local-only mode, a network log of every outbound request, API keys in your OS credential
  store, secrets redacted before anything is sent, optional local embeddings.
- **Safe to let loose.** OS-level sandbox for agent commands (no network, workspace only), prompt-injection quarantine,
  permission gate with a deny list, audit log.
- **Verified work.** The agent runs your tests, linter and type-checker, reads structured failures, and fixes them. A guard
  flags weakened tests.
- **Parallel, isolated agents.** Several agent threads at once; an isolated thread gets its own git worktree and branch, and you merge or discard it.
- **Optional inline completions.** Ghost text as you type, off by default and clear about what it sends.
- **Any model, any agent.** Anthropic, OpenAI-compatible and local (Ollama) models; MCP servers; ACP agents.
- **Fast.** The window is interactive in about 0.1 s (only 355 KB of JavaScript at startup); a 120,000-file repo indexes in about 5 s and a semantic search over it takes about 7 ms. Measurements and method: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Status
Windows is the verified platform (build, installer, and a 24-test end-to-end suite that drives the real window).
CI is green on Windows, macOS and Linux (lint, typecheck, unit tests, Rust tests, build); the real-window end-to-end suite runs on Windows only, and macOS and Linux have not been exercised by a person. Screen-reader support is covered by automated
accessibility checks only. See [CHANGELOG.md](CHANGELOG.md), [ARCHITECTURE.md](ARCHITECTURE.md) and
[docs/RESEARCH.md](docs/RESEARCH.md) (competitive research and roadmap).

## Develop
Requirements: Node 26 (the agent runtime is built as a Node single-executable), Rust stable, and on Windows the MSVC
toolchain and WebView2.

```
npm ci
npm run build:sidecar   # builds the agent-runtime executable Tauri bundles
npm run dev             # launches the desktop app
npm test                # unit tests
npm run lint && npm run typecheck
cargo test --workspace
```

End-to-end (Windows): `pwsh scripts/desktop-e2e.ps1`.

## Command line
```
npm run build:cli
export FORGE_API_KEY=...            # or ANTHROPIC_API_KEY / OPENAI_API_KEY; Ollama needs none
node target/cli/forge-code.cjs ask "where is auth handled?" --model llama3.1
node target/cli/forge-code.cjs run "add input validation to signup" --model llama3.1   # prints diffs, writes nothing
node target/cli/forge-code.cjs run "..." --model llama3.1 --apply                      # writes them
```
`--json` gives a machine-readable result; exit code 2 means it stopped at a step or cost limit.

To let the agent run tests or linters, allow them explicitly: `run "fix the failing test" --allow "npm test" --apply`. Nothing runs unless listed, wildcards (`"npm run *"`) never permit chained or redirected commands, and the CLI has no OS sandbox (the desktop app does), so only allow commands you trust.

## Saved prompts
Put reusable prompts in `.forge/prompts/<name>.md` (optional `description:` front matter; `$ARGUMENTS` is replaced by what follows the command). In the app type `/` to pick one; on the command line run `forge-code run "/name args"`. Commit the folder to share workflows with your team.

## Skills
A skill is a folder `.forge/skills/<name>/` with a `SKILL.md` (optional `description:` front matter) and any scripts or reference files it needs. The agent sees the list, loads a skill when a task calls for it, and can run its bundled scripts (`.js .mjs .cjs .py .sh`); you are asked before every script runs, and it runs in the OS sandbox when that is on. Scripts are code from your repository: only open repositories you trust, as with any project that has build scripts. A skill can declare its scripts' arguments in a `tools.json` next to them so wrong calls are rejected before they run, and you can keep personal skills in `~/.forge/skills` (a repository skill with the same name wins). The Context > Skills panel lists them. The command-line tool uses skills for instructions only.

## Layout
`apps/desktop` (Tauri + React), `crates/forge-core` (Rust: filesystem, index, sandbox, secrets), `packages/*` (TypeScript:
agent runtime, model gateway, tools, review, verification, safety, MCP, ACP). Rules for agents working in this repo are
in [AGENTS.md](AGENTS.md).
