## Model & Tool Routing
- Search/Discovery: Delegate all repo exploration and grep searches to Haiku subagents.
- QA/Checks: Delegate `npm test`, `npm run lint`, and `npm run typecheck` to `qa-runner` (Haiku).
- Architecture: Consult `opus-architect` (or advisor) ONLY before multi-file refactors, schema/auth changes, or after 2 failed fix attempts.
- Agent Teams: Max 3 teammates. Assign `haiku` to all workers; keep lead on `sonnet`.

## Token Hygiene
- Never read lockfiles or build outputs (`node_modules/`, `dist/`, `build/`, `.next/`).
- Use `offset`/`limit` line ranges when reading files >300 lines.
- Edit minimal diffs only. Reply with changed file paths and root cause only—no filler summaries.
