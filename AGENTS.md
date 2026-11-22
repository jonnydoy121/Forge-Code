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
- e2e: `npm run e2e`
- build: `npm run build`

## Rules
- Add or update the contract in `packages/protocol` before changing a component's behaviour.
- Tests first where practical; never weaken or skip a test to pass checks.
- Prefer boring, well-supported libraries; justify each new dependency in the PR/commit.
- Keep ARCHITECTURE.md, AGENTS.md and CHANGELOG.md current.
- Phases are sequential; stop for approval between phases.
