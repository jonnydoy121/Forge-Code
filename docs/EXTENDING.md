# Extending Forge-Code

Extension points are plain files in the repo, plus a small typed SDK (`@forge/sdk`, in `packages/sdk`) for writing tools and hooks.

- **Rules**: `.forgerules` (or `AGENTS.md`, `CLAUDE.md`, `.cursorrules`) at the repo root; scoped rules in `.forge/rules/`. Commit them so everyone gets the same behaviour.
- **Skills and custom tools**: a folder with `SKILL.md`; scripts inside it can be exposed as typed tools by declaring them in `tools.json`. They run sandboxed and ask for permission. A bad declaration is reported, not ignored.
- **Lifecycle hooks**: `.forge/hooks.json`.
- **MCP servers**: `.forge/mcp.json` (`{"servers": {...}}` or `{"mcpServers": {...}}`). Big results are compacted locally.
- **Specialist agents**: `.forge/agents/<name>.md` with `description`, `tools` and `tier` in the frontmatter and the instructions as the body. Read-only tools only.
- **Scheduled and headless runs**: see [AUTOMATION.md](AUTOMATION.md).

## The SDK

A custom tool (a script in a skill, declared in `tools.json`):

```ts
import { defineTool, runTool, toolsManifest } from "@forge/sdk";
const bump = defineTool({
  description: "Bump the version",
  parameters: { type: "object", properties: { level: { type: "string", enum: ["patch", "minor", "major"] } }, required: ["level"] },
  run: (args, { cwd }) => `bumped ${args.level} in ${cwd}`,
});
runTool(bump).then((code) => process.exit(code));
// toolsManifest({ "bump.js": bump }) is the text of the skill's tools.json
```

A lifecycle hook (a command in `.forge/hooks.json`; exit 2 blocks the action):

```ts
import { runHook } from "@forge/sdk";
runHook((i) => (i.file.endsWith(".secret") ? { block: `do not touch ${i.file}` } : undefined)).then((code) => process.exit(code));
```

The SDK has no dependencies besides Node; bundle it into your script (esbuild) or copy `packages/sdk/src/index.ts` next to it. It is not published to npm.

Exact field names for hooks and tools are defined in `packages/context-store/src/skills.ts` and `apps/desktop/src/lib/workspace.ts`.
