# Changelog

## Unreleased
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
