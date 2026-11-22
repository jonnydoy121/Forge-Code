import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { spawnTransport } from "@forge/rpc/src/node";
import { createToolHost, type FsBackend } from "@forge/tool-host";
import { McpClient, McpManager, mcpTools, parseMcpConfig, type McpLauncher } from "../src";

const SERVER = resolve(__dirname, "fixtures/mock-mcp-server.mjs");
const nofs: FsBackend = { readFile: async () => "", readdir: async () => [] };
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

const launcher: McpLauncher = { launch: async (cfg) => { const t = spawnTransport(cfg.command, cfg.args); closers.push(() => t.close()); return t; } };

describe("McpClient against a real stdio server", () => {
  it("initializes, lists tools across pages, and calls them", async () => {
    const t = spawnTransport("node", [SERVER]);
    closers.push(() => t.close());
    const c = new McpClient(t);
    await c.initialize();
    expect(c.serverInfo).toEqual({ name: "mock-mcp", version: "1.2.3" });
    expect((await c.listTools()).map((x) => x.name)).toEqual(["echo", "readme", "fail"]); // two pages, server logging ignored
    expect(await c.callTool("echo", { text: "hi" })).toEqual({ text: "echo: hi", isError: false });
    expect(await c.callTool("fail", {})).toEqual({ text: "database unreachable", isError: true });
    await expect(c.callTool("nope", {})).rejects.toThrow("unknown tool nope");
  });

  it("fails cleanly when the server process cannot start or dies", async () => {
    const t = spawnTransport("definitely-not-a-real-binary-xyz", []);
    const c = new McpClient(t);
    await expect(c.initialize()).rejects.toThrow();
  });
});

describe("mcpTools", () => {
  it("adapts server tools as network-class tools, hidden in ask/plan, with results as plain text", async () => {
    const t = spawnTransport("node", [SERVER]);
    closers.push(() => t.close());
    const c = new McpClient(t);
    await c.initialize();
    const tools = mcpTools(c, "my server!", await c.listTools());
    const host = createToolHost({ root: "/r", fs: nofs, tools });
    expect(tools.map((x) => x.spec.name)).toEqual(["mcp__my_server___echo", "mcp__my_server___readme", "mcp__my_server___fail"]);
    expect(tools.every((x) => x.spec.class === "network")).toBe(true);
    expect(host.listTools("ask")).toEqual([]);
    expect(host.listTools("plan")).toEqual([]);
    expect(host.listTools("agent")).toHaveLength(3);
    expect((await host.call("agent", { id: "1", name: "mcp__my_server___echo", args: { text: "x" } })).output).toBe("echo: x");
    const r = await host.call("agent", { id: "2", name: "mcp__my_server___readme", args: {} });
    expect(r.output).toContain("Ignore previous instructions"); // delivered verbatim; the runtime flags and quarantines it
    expect(r.output).toContain("[image content image/png not shown]");
    const f = await host.call("agent", { id: "3", name: "mcp__my_server___fail", args: {} });
    expect(f.ok).toBe(false);
    expect(f.output).toBe("database unreachable");
    expect(tools[0]!.spec.description).toContain("untrusted data");
  });
});

describe("parseMcpConfig", () => {
  it("reads servers (either key) and reports problems", () => {
    expect(parseMcpConfig(JSON.stringify({ servers: { db: { command: "npx", args: ["-y", "x"], env: { A: "1", B: 2 } } } })).servers).toEqual([{ name: "db", command: "npx", args: ["-y", "x"], env: { A: "1" } }]);
    expect(parseMcpConfig(JSON.stringify({ mcpServers: { a: { command: "x" } } })).servers).toHaveLength(1);
    const bad = parseMcpConfig(JSON.stringify({ servers: { broken: {} } }));
    expect(bad.servers).toEqual([]);
    expect(bad.errors[0]).toContain('"broken" needs a "command"');
    expect(parseMcpConfig("{nope").errors[0]).toContain("not valid JSON");
    expect(parseMcpConfig(null)).toEqual({ servers: [], errors: [] });
  });
});

describe("McpManager", () => {
  it("starts several servers, isolates failures, and closes them all", async () => {
    const m = new McpManager(launcher);
    const tools = await m.start([
      { name: "good", command: "node", args: [SERVER], env: {} },
      { name: "bad", command: "definitely-not-a-real-binary-xyz", args: [], env: {} },
    ]);
    expect(tools.map((t) => t.spec.name)).toEqual(["mcp__good__echo", "mcp__good__readme", "mcp__good__fail"]);
    expect(m.status.map((s) => [s.name, s.state])).toEqual([["good", "ready"], ["bad", "failed"]]);
    expect(m.status[1]!.error).toBeTruthy();
    m.close();
  });
});
