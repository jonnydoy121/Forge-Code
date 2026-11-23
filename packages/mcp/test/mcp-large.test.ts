// The whole path with a real server process that behaves like a game-editor bridge: huge results are shrunk before the model sees them.
import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { spawnTransport } from "@forge/rpc/src/node";
import { createToolHost, type FsBackend } from "@forge/tool-host";
import { McpClient, mcpTools } from "../src";

const SERVER = resolve(__dirname, "fixtures/scene-mcp-server.mjs");
const nofs: FsBackend = { readFile: async () => "", readdir: async () => [] };
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

async function connect(opts?: { maxChars?: number }) {
  const t = spawnTransport("node", [SERVER]);
  closers.push(() => t.close());
  const c = new McpClient(t);
  await c.initialize();
  const host = createToolHost({ root: "/ws", fs: nofs, tools: mcpTools(c, "scene", await c.listTools(), opts) });
  return (name: string) => host.call("agent", { id: "1", name: `mcp__scene__${name}`, args: {} });
}

describe("big results from an MCP server", () => {
  it("a scene dump of several hundred KB reaches the model as a few KB, with the first objects and a note", async () => {
    const call = await connect();
    const r = await call("get_scene");
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(12_000);
    expect(r.output).toContain("compacted locally");
    expect(r.output).toContain("mcp__scene__get_scene");
    expect(r.output).toContain("Wall_0000");
    expect(r.output).toMatch(/more items/);
    expect(r.output).not.toContain("Wall_3999");
  });

  it("a build log keeps its beginning and its end", async () => {
    const call = await connect();
    const r = await call("get_build_log");
    expect(r.output.length).toBeLessThanOrEqual(12_000);
    expect(r.output).toContain("[0] compiling Assets/Scripts/Module0.cs");
    expect(r.output).toContain("[5999] compiling Assets/Scripts/Module5999.cs");
    expect(r.output).toMatch(/characters omitted/);
  });

  it("a failing build still FAILS, and the compiler error at the end of its long log is kept", async () => {
    const call = await connect();
    const r = await call("build");
    expect(r.ok).toBe(false);
    expect(r.output.length).toBeLessThanOrEqual(12_000);
    expect(r.output).toContain("error CS0103: The name 'Rigidbody2D' does not exist in the current context");
  });

  it("leaves small results alone, and the limit can be changed", async () => {
    const call = await connect();
    expect((await call("ping")).output).toBe("pong");
    const tight = await connect({ maxChars: 2000 });
    expect((await tight("get_scene")).output.length).toBeLessThanOrEqual(2000);
  });
});
