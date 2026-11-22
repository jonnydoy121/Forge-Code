# Changelog

## Unreleased
### Headless CLI (research gap #6)
- `forge-code ask "..."` (read-only) and `forge-code run "..."` (agent). Review-first like the app: `run` prints unified diffs and writes nothing unless `--apply`. `--json` for scripts, exit codes 0 done / 1 error / 2 stopped at a limit, `--max-steps`, `--max-cost`. The API key comes only from `FORGE_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (no flag, so it cannot leak into shell history). No shell commands are offered to the model in this first version. Build with `npm run build:cli` (one file: `node target/cli/forge-code.cjs`). Verified by unit tests and by running the bundle as a real process against a mock model server.

### Race fix found by CI
- `Background::read` could report a finished process before its output readers had copied the final lines, so the agent could miss a process's last output (flaky on Linux CI). It now waits (bounded, 500 ms) for the readers to drain once the process has exited.

### Parallel agent threads (research gap #2)
- Several agent threads run at once: a tab strip above the agent panel (`+` to add, "Close thread" for finished ones). Each thread is its own conversation with its own runtime (worker or process), keeps running while hidden, and shows a running dot. Edits from every thread land in the shared review queue and go through the usual conflict check on accept.
- Concurrency fixes this needed: permission prompts now queue instead of overwriting each other (a second prompt used to orphan the first), per-thread saved sessions, per-thread runtime cleanup (the global "live runtime" that would have killed other threads' runtimes is gone), and a run counter so accepting changes mid-run never triggers the post-accept verification.
- Not done: a git worktree per thread. Two threads editing the same file are caught at accept time (conflict check), not prevented. The permission queue is untested under real concurrent prompts. The conversation log is now keyboard-focusable (axe).

### First CI run (Windows and macOS green, Ubuntu found a real bug)
- On Linux a command that exceeded its timeout was not actually stopped: only the shell was killed, its child kept the output pipes open (the timeout test took 30 s). Commands, background processes and MCP/ACP processes now start in their own process group on Unix and the whole group is killed (`exec.rs`, `bg.rs`, `proc.rs`).
- The keyring test skips on headless Linux (no Secret Service); CI annotates cargo failures so they can be read without log access.

### Forge-Code branding, research and inline edit
- Product name is now **Forge-Code** (window title, installer name, welcome screen, UI text, README). Technical identifiers are unchanged on purpose (`dev.forge.editor`, crate and binary names) so credential-store entries and installed data keep working.
- Added `docs/RESEARCH.md`: competitor landscape (Cursor, Windsurf/Devin Desktop, Zed, Kiro, Cline, Aider, Continue) from vendor docs, a gap analysis and a ranked roadmap. Evidence is vendor-side only; independent reviews were not available.
- Inline edit (research gap #1): select code (or place the cursor), press Alt+I or use the context menu, describe the change. A one-shot model call with no tools returns the replacement, which is proposed as a normal pending change (per-hunk review, nothing written until accepted). Refuses unsaved buffers. Unit tests plus an e2e in the real window.
### Live ACP agent (Claude Code via @agentclientprotocol/claude-agent-acp)
- First run against a real external agent found that it starts in its own permissive mode ("auto", inherited from the user's Claude settings) and edited a file on disk without asking Forge. The ACP client now switches every session to the agent's ask-first mode ("default") when offered, so edits reach Forge's permission gate. Verified live: Forge was asked for Read (allowed) and Edit (refused), and the file stayed unchanged. Opt-in test: `FORGE_LIVE_ACP=1 npx vitest run packages/acp/test/live` (uses the developer's Claude account).
- Fixed `spawnTransport` on Windows (`spawn EINVAL` for .cmd shims such as npx).
- An external agent's Edit/Write permission request is now captured: Forge computes the new content from the request, hands it to the pending-changes model, and refuses the agent's own write (no prompt, nothing touches the disk). Ambiguous or underivable edits fall back to the normal prompt; `interceptEdits: false` restores the old behaviour. Verified live against Claude Code and by unit tests.
### Remaining-gaps follow-up
- Pending changes persist across restarts (.forge/pending, restored with reasons, decisions and change sets; the normal conflict check still runs on accept).
- The agent loop can run in its own OS process: `forge-runtime`, a Node single-executable (`npm run build:sidecar`, about 100 MB because it embeds Node) bundled as a Tauri `externalBin` and driven over newline-delimited JSON on stdio (same protocol as the worker, `stdio.ts`). Falls back to the Web Worker if it cannot start; the panel shows `agent: process|worker`. Exits when the host closes its stdin, so no orphans. Verified: unit test against a real child process and against the packaged exe, and an e2e in the real window asserting `agent: process`.
- The agent loop (context assembly, compaction, redaction, limits, verify-fix feedback) runs in a Web Worker behind a typed message protocol (`agent-runtime/src/remote.ts`); files, HTTP, permissions, hooks, verification and indexing stay on the main thread and are served to the worker. Falls back to in-process when Workers are unavailable. This is a thread boundary, not an OS process: no Node sidecar is bundled.
- Neural embeddings: optional local Ollama-compatible embedder (`Embedding model` setting, loopback only, probes the vector size, falls back to the built-in lexical embedder with a notice, zero vectors on a later outage). Verified against a mock server, including a case the lexical embedder cannot answer; not yet run against a real Ollama (none installed here).
- Indexer: bounded in-memory content cache. On a synthetic 120,000-file / 960k-line repo: first index 5.8 s (background, search usable during it), warm grep about 10 ms (was 1.07 s), symbol lookup under 1 ms, incremental reindex 15 ms. The first search after launch is cold (about 1 s) while the cache fills.
### Security follow-up
- API keys now live in the OS credential store (Windows Credential Manager via the keyring crate), per provider; existing keys in local storage are migrated and settings never persist them.
### Phase 9 - Polish
- First-run welcome: privacy choice (local-only vs hosted) and edit-review preference come first; keyboard-operable; reachable again from the palette.
- Accessibility: axe-core audit (no serious or critical violations in editor, agent panel, settings, Context, Plan and palette views) with fixes to the file tree (tree/treeitem/group), tabs (no nested controls), tab lists and the palette listbox; keyboard-only flows tested.
- Performance: LSP document sync is debounced and lazy (typing in a 5,000-line file went from about 52 ms to about 3 ms per key); opening that file takes about 60 ms.
- Packaging: Windows NSIS installer built (`Forge_0.0.0_x64-setup.exe`, 6.6 MB) and the release exe launches; a `package` workflow builds bundles on Windows, macOS and Linux (not yet run).
### Phase 8 - Safety and extensibility
- Safety: persisted audit log and network log (secrets redacted), local-only mode via a guarded fetch (policy refusals are never retried), prompt-injection detection with quarantine banners, credential-path guard, outbound secret redaction, wall-clock limit, permission gate with deny list.
- Sandbox: Rust AppContainer on Windows (workspace-only writes, no network incl. loopback, no profile or credential access, kill-on-close job) with scrubbed env; env-only fallback elsewhere. Verified with positive-control tests. Background processes (no network sandbox, always gated).
- `run_command`/`bg_*` tools; MCP client (stdio) and ACP client; external agents' file writes go to the review UI. Tested against real subprocess fixtures (mock MCP server and mock ACP agent; no real Claude Code/Gemini/Codex was available).
### Phase 7 - Rules and memory
- `@forge/context-store`: rule engine with the full precedence chain (user rules < AGENTS.md and imported CLAUDE.md, .cursorrules, .cursor/rules, .windsurfrules, copilot instructions < nested AGENTS.md, nearest last < scoped .forge/rules with always/auto/agent/manual activation), per-rule "why it applies" reasons, a rules linter (contradictions with ESLint, Prettier, editorconfig, dependencies, scripts, and secrets), AGENTS.md generation from the repo, memories as Markdown files (project and personal), correction detection, docs indexing with BM25 retrieval, session transcripts, fresh-thread suggestion.
- Runtime: compaction near a threshold (default 80%) keeping rules, plan, file list and open decisions, PreCompact/PostCompact hooks, summaries folded across compactions; token meter calibrated to provider-reported usage; sub-agents (`delegate`) with a fresh read-only context that return only a report.
- UI: Context pane (rules with reasons and warnings, memories, docs), attachment chips (file, folder, symbol, docs, web, git diff, terminal, rule, memory), meter breakdown by category, compaction notice with the summary, memory/rule offers on corrections, new-thread suggestion, resume of the previous session. App shortcuts now use a capture-phase listener so they win over Monaco bindings.
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
