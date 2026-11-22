# Changelog

## Unreleased
### Phase 6 - Planning
- `@forge/plans`: plan files (.forge/plans/<slug>.md) with a forgiving parser, validation (goal, tasks, acceptance checks), in-place status/comment/file edits, `write_plan` and `ask_user` tools (at most 3 questions, with defaults), PlanStore, PlanExecutor (step-by-step, status tracked in the file, pause/resume from the first unverified step), PlanGuard (edits outside the plan stop and ask; approval records the file in the plan), conservative intent classification ("go" builds; "update the plan and go" never does) and a large-request heuristic.
- Mode enforcement: new `plan` tool class (Plan mode can read and write the plan file only); mode-specific system prompts.
- UI: plan pane with live checklist (pending / in progress / verified / failed), Build, Pause, Resume, step comments, question and add-file prompts, "Plan first?" suggestion for large requests. Each step's changes are tagged with its step number in the review pane and checkpoints.
### Phase 5 - Verification loop
- `@forge/verify`: command discovery (package.json, Makefile, pyproject, Cargo, go.mod, CI) round-tripped through an AGENTS.md `## Commands` section, structured error parsers (tsc, eslint, cargo, node:test, pytest, vitest/jest, go test, ruff/flake8, tracebacks; verified against real tool output), scoped fast checks and full runs, verification report with the Verified rule, test-weakening guard (suppressions, skipped tests, removed assertions), lifecycle hooks (.forge/hooks.json: PreToolUse, PostToolUse, PostEdit, Stop, SessionStart; PreCompact/PostCompact reserved for Phase 7).
- Agent runtime verify-fix loop: fast checks after each change set that reaches disk, full run before finishing, structured feedback to the model, 5 attempts then a tool-less report turn (what was tried, remaining error, hypothesis). Flagged edits are forced through developer approval even in auto modes.
- `@forge/safety`: permission gate (allow once / session / always pattern, persisted in .forge/permissions.json) with a deny list that always asks and can never be remembered; remembered patterns cannot authorise chained commands.
- Rust command runner with timeout, output caps and a Windows quoting fix; `run_checks` tool (execute-class, gated); report card, permission prompt and per-file verification badges in the UI.
### Phase 4 - Editing, review, checkpoints
- `@forge/review`: Myers line diff, word-level highlights, per-hunk apply, three-way merge (diff3), PendingChanges model (review / plan-files / auto modes, per-hunk reasons, change sets, conflict detection that never overwrites developer edits).
- `@forge/checkpoints`: persisted FileCheckpointStore (snapshot before every write, 100+ retained, rollback by checkpoint, step, change set, file or hunk; rollbacks are themselves checkpointed).
- Edit tools (edit_file, write_file, delete_file) behind the same mode enforcement; reads see pending proposals via an overlay.
- UI: multi-file review pane (inline/side-by-side, Accept/Reject/Edit/Explain/Comment per hunk, keyboard shortcuts, three-way conflict view), inline editor decorations, checkpoint timeline (restore code / conversation / both, hunk rollback, shell-side-effect warning), commit with drafted message and branch creation through an allowlisted git surface.
### Phase 3 - Indexing
- Rust indexer in forge-core: .gitignore/.forgeignore/secret-aware walk, Merkle tree change detection, tree-sitter symbols/imports/references/chunks for TS/JS, Python, Go, Rust, Java, C#, C, C++, SQLite persistence, local hashing embeddings cached by chunk hash, file graph with personalised PageRank repo map, debounced file watcher.
- Retrieval tools for the agent: repo_map, semantic_search, grep, symbol, references, dependency_cone; repo map attached to context automatically.
- Benchmark (69,634 files / 6.65M lines): first index 9.1 s in background, incremental reindex 37 ms, symbol 2.4 ms, repo_map 13 ms, semantic search 50 ms, full-repo grep 540-800 ms (about 80-120 ms per million lines).
### Phase 2 - Agent loop + Ask mode
- Model gateway: Anthropic and OpenAI-compatible (OpenAI, Ollama) streaming adapters, SSE parser, retry with backoff on 429/5xx, cost tracking, audit hook that labels each request local or REMOTE.
- Agent runtime: loop with tool dispatch, permission gate hook, step/cost/abort limits, secret redaction of tool output, prompt-injection-aware system prompt, priority-based context assembly with token meter.
- Tool host: read_file, ls, grep with workspace confinement, secret-file blocking, mode enforcement (write/execute never listed or callable in ask/plan).
- Agent panel: streaming chat, mode selector (Shift+Tab), context chips, token meter, cost, settings, audit log, local/remote badge.
- HTTP via tauri-plugin-http (no webview CORS).
### Phase 1 - Editor core
- File tree (lazy, hides .git/node_modules/target), tabs with dirty state, Monaco buffers, atomic save (Ctrl+S).
- Command palette (Ctrl+Shift+P, fuzzy), keybindings, light/dark theme toggle.
- Integrated terminal: Rust `portable-pty` + xterm.js (Ctrl+`).
- LSP client (TypeScript/JS via typescript-language-server, Python via pyright) with diagnostics shown as Monaco markers and a status-bar error/warning count.
- Tests: Rust fs/LSP-framing units, TS units (LspClient, tabs, palette, URIs), real-server LSP integration test, desktop e2e over WebView2 CDP.
### Phase 0 - Plan and scaffold
- Monorepo (npm workspaces + Cargo workspace), Tauri 2 + React/TS/Tailwind shell.
- `@forge/protocol` contracts and stub components with contract tests; mode enforcement test.
- Vitest, cargo test and Playwright smoke harness; GitHub Actions CI (Windows/macOS/Linux).
