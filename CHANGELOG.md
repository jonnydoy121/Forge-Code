# Changelog

## Unreleased
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
