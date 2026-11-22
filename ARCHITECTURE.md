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

## Editor core (Phase 1)
- UI: `apps/desktop/src` (React + Monaco + xterm.js). Pure logic in `src/lib` (LspClient, tabs, commands, URIs) has no Tauri/Monaco imports so it is unit-tested.
- Rust host (`src-tauri`): thin Tauri commands over `crates/forge-core` (fs, LSP framing and server resolution) plus PTY and LSP process management. Events: `pty-data`, `lsp-msg`.
- LSP servers are npm devDependencies resolved from `<workspace>/node_modules/.bin`, then the repo's, then PATH. Missing servers show "LSP: unavailable" with the reason.
- Monaco is pinned to 0.52.2 (import layout changed in later releases).

## Indexer (Phase 3)
- Lives in `crates/forge-core/src/index`; exposed to the UI through Tauri commands (`index_*`) and to the agent as tools (`packages/indexer`).
- Per-file results (symbols, imports, refs, chunk hashes, embeddings) persist in `.forge/index/index.db` (SQLite). Derived maps live in memory and update incrementally.
- Deviations from the spec, deliberate: embeddings are a local feature-hashing model (offline, deterministic, not neural; the `Embedder` trait is the seam for Ollama or hosted models); vectors are scanned brute-force instead of using sqlite-vec; graph edges are name-based (calls, inheritance and type uses all appear as identifier references) plus resolved imports; test-covers edges are derived from test-named files.
- Process model: the TypeScript "workers" (runtime, gateway, tool host) run inside the webview today, calling Rust for fs, indexing, PTY and LSP. Moving them to separate processes remains open.

## Review and checkpoints (Phase 4)
- Agent writes go through `EditSink` -> `PendingChanges`; disk is written only on accept (or immediately in auto mode), always after a checkpoint of the pre-write content.
- Conflicts: if disk differs from the proposal's base at accept time, a three-way merge runs; clean merges apply, overlapping edits surface a conflict view and nothing is written.
- Known gaps: pending changes live in memory (not persisted across restarts); the conversation transcript is not yet persisted (Phase 7); the index does not see pending proposals, only the overlay used by read_file does.

## Verification (Phase 5)
- The agent runs only the project's own configured checks (`run_checks`), never arbitrary shell. A general `run_command` tool and the PTY-visible agent terminal arrive with the sandbox in Phase 8.
- Verification runs against files on disk. In review mode, proposals are pending, so the run reports "Unverified: changes are pending your review" and verification runs automatically after the developer accepts the last pending file. Auto and plan-files modes verify autonomously.
- Heuristic limits: weakening detection catches suppressions, skips, removed assertions and weaker matchers; it cannot tell that a changed expected value is wrong, so an edit to a test file should still be read by the developer.

## Planning (Phase 6)
- Plan mode exposes read tools plus `write_plan`/`ask_user`; write and execute tools are not listed at all. Build switches to Agent mode and runs one step per agent turn, tagging changes with the step number.
- A step is marked verified when its agent turn ends without failed checks and the developer has resolved the step's pending changes; if no checks are configured the step is still marked verified, with an "Unverified" report beside it.
- Not yet: splitting plan steps across sub-agents (Phase 7 adds sub-agents generally).

## Context management (Phase 7)
- Rules are rebuilt as system sections on every turn, so they and the active plan survive compaction by construction; only conversation history is summarised.
- Token meter: estimate is chars/4 over system, history and tool specs, scaled by a rolling ratio against the provider's reported input tokens. Within 5% is verified against a simulated provider; models that report no usage (some local ones) show an estimate, labelled "(est.)".
- Docs retrieval is lexical (BM25), not vector search; fetching happens only when the developer asks, and the content is labelled untrusted reference data.
- The "agent" rule activation is implemented as an index of descriptions plus a `get_rule` tool.

## Status
Phases 0-9 built. Not verified: CI and packaging on macOS/Linux, real external agents, screen-reader testing by a human. See CHANGELOG.md.
