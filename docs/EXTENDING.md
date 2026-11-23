# Extending Forge-Code

There is no separate SDK; extension points are plain files in the repo.

- **Rules**: `.forgerules` (or `AGENTS.md`, `CLAUDE.md`, `.cursorrules`) at the repo root; scoped rules in `.forge/rules/`. Commit them so everyone gets the same behaviour.
- **Skills and custom tools**: a folder with `SKILL.md`; scripts inside it can be exposed as typed tools by declaring them in `tools.json`. They run sandboxed and ask for permission. A bad declaration is reported, not ignored.
- **Lifecycle hooks**: `.forge/hooks.json`.
- **MCP servers**: `.forge/mcp.json` (`{"servers": {...}}` or `{"mcpServers": {...}}`). Big results are compacted locally.
- **Specialist agents**: `.forge/agents/<name>.md` with `description`, `tools` and `tier` in the frontmatter and the instructions as the body. Read-only tools only.
- **Scheduled and headless runs**: see [AUTOMATION.md](AUTOMATION.md).

Exact field names for hooks and tools are defined in `packages/context-store/src/skills.ts` and `apps/desktop/src/lib/workspace.ts`.
