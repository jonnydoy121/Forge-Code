# AGENTS.md (Forge repo)

## Layout
- `apps/desktop`: Tauri 2 shell + React/TS/Tailwind UI. `src-tauri` is the Rust host.
- `packages/*`: TS workers. Contracts live in `packages/protocol`; every package implements one and has contract tests in `test/`.
- `crates/forge-core`: Rust core (indexer, sandbox, checkpoints).

## Commands
- test: `npm test` (Vitest) and `npm run test:rust` (cargo)
- typecheck: `npm run typecheck`
- lint: `npm run lint`
- dev: `npm run dev`
- e2e: `npm run e2e` (web smoke). Desktop e2e: launch `npm run dev` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and `FORGE_WORKSPACE=<dir>`, then run `npx playwright test desktop.spec.ts` in apps/desktop with `FORGE_CDP=http://127.0.0.1:9222 FORGE_WS=<dir>`
- build: `npm run build`

## Rules
- Add or update the contract in `packages/protocol` before changing a component's behaviour.
- Tests first where practical; never weaken or skip a test to pass checks.
- Prefer boring, well-supported libraries; justify each new dependency in the PR/commit.
- Keep ARCHITECTURE.md, AGENTS.md and CHANGELOG.md current.
- Phases are sequential; stop for approval between phases.
