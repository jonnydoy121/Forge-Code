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
- **Any model, any agent.** Anthropic, OpenAI-compatible and local (Ollama) models; MCP servers; ACP agents.
- **Fast on big repos.** Tree-sitter index, repo map and semantic search; a 120,000-file repo indexes in about 6 s.

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

## Saved prompts
Put reusable prompts in `.forge/prompts/<name>.md` (optional `description:` front matter; `$ARGUMENTS` is replaced by what follows the command). In the app type `/` to pick one; on the command line run `forge-code run "/name args"`. Commit the folder to share workflows with your team.

## Layout
`apps/desktop` (Tauri + React), `crates/forge-core` (Rust: filesystem, index, sandbox, secrets), `packages/*` (TypeScript:
agent runtime, model gateway, tools, review, verification, safety, MCP, ACP). Rules for agents working in this repo are
in [AGENTS.md](AGENTS.md).
