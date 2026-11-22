# Forge Architecture

Forge is a desktop, AI-native code editor. The agent is a first-class part of the editor; the developer stays in control (every change is a visible, reversible diff tied to a plan step).

## Process model
Heavy AI and indexing work never runs on the UI thread. Each component has a typed interface in `packages/protocol` and its own tests.

| Component | Process | Location (Phase 0) |
|---|---|---|
| Editor shell, Agent panel, Review surface | UI (Tauri webview, React) | `apps/desktop/src` |
| Agent runtime | Worker (Node/TS) | `packages/agent-runtime` |
| Model gateway | Worker (Node/TS) | `packages/model-gateway` |
| Tool host (+ MCP client) | Worker (Node/TS) | `packages/tool-host` |
| Context store (rules, memories, plans) | Worker (Node/TS) | `packages/context-store` |
| Checkpoint store | Worker (TS now, Rust later) | `packages/checkpoints` |
| Indexer | Worker (Rust core, TS facade) | `packages/indexer`, `crates/forge-core` |
| Sandbox | Child processes (Rust) | `crates/forge-core` (Phase 8) |

Desktop shell: Tauri 2 (Rust core + web UI). Core services are mixed on purpose: TypeScript for LLM-facing code (fast iteration), Rust for indexer, sandbox and checkpoints (speed, OS APIs).

## Agent loop (one turn)
1. Assemble context within a token budget: rules > plan > task files > repo map > retrieved chunks > older conversation.
2. Call the model via the gateway, streaming to the panel.
3. Dispatch tool calls through the permission gate to the tool host.
4. Snapshot affected files in the checkpoint store before any write.
5. Run hooks after each tool call; feed results back.
6. Repeat until no tool calls, plan step verified, or a step/time/cost limit hits.
7. Compact near the threshold; persist plan, decisions, file list; re-inject rules.

## Invariants
- Mode is enforced by the tool host: Ask/Plan never expose write or execute tools (`packages/protocol/src/modes.ts`, tested).
- Secrets are never indexed or sent to a model (`.forgeignore` + redaction).
- Code stays local by default; anything sent to a model is explicit.
- Checkpoints cover file edits only, not shell side effects.

## Protocols
MCP client (external tools), ACP client (external agents), LSP client (diagnostics, definitions, references).

## Status
Phase 0: contracts and stubs only. See CHANGELOG.md.
