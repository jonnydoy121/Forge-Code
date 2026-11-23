// The error bridge with a real MCP server process: when the external app keeps saying no, the architect takes over.
import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { AgentEvent, StreamEvent, ToolHost } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { McpClient, mcpTools } from "@forge/mcp";
import { spawnTransport } from "@forge/rpc/src/node";
import { READ_TOOLS, createToolHost, type FsBackend } from "@forge/tool-host";
import { Runtime, type RoutingConfig } from "../src";

const SERVER = resolve(__dirname, "../../mcp/test/fixtures/mock-mcp-server.mjs");
const fs: FsBackend = { readFile: async () => { throw new Error("ENOENT"); }, readdir: async () => [] };
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

const done: StreamEvent = { type: "done", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0 } };
const call = (id: string, name: string, args: Record<string, unknown> = {}): StreamEvent[] => [{ type: "tool_call", call: { id, name, args } }, done];
const text = (t: string): StreamEvent[] => [{ type: "text", delta: t }, done];
const cfg: RoutingConfig = { architect: { provider: "architect", model: "architect-model" } };

async function tools(gate?: { check: () => Promise<"allow" | "deny"> }): Promise<{ host: ToolHost; gate?: typeof gate }> {
  const t = spawnTransport("node", [SERVER]);
  closers.push(() => t.close());
  const c = new McpClient(t);
  await c.initialize();
  return { host: createToolHost({ root: "/ws", fs, tools: [...READ_TOOLS, ...mcpTools(c, "mock-mcp", await c.listTools())] }), gate };
}
async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const models = (gw: ScriptedGateway) => gw.requests.map((r) => `${r.provider}/${r.model}`);
const FAIL = "mcp__mock-mcp__fail";

describe("an external tool that keeps failing", () => {
  it("is the builder's first attempt and the architect's second: the third request goes to the architect", async () => {
    const { host } = await tools();
    const gw = new ScriptedGateway([call("1", FAIL), call("2", FAIL), call("3", "mcp__mock-mcp__echo", { text: "ok" }), text("recovered")]);
    const rt = new Runtime({ gateway: gw, tools: host, provider: "default", model: "builder-model", routing: cfg });
    const events = await drain(rt.run({ mode: "agent", prompt: "make the build pass" }));
    expect(models(gw)).toEqual(["default/builder-model", "default/builder-model", "architect/architect-model", "architect/architect-model"]);
    const route = events.find((e): e is Extract<AgentEvent, { type: "route" }> => e.type === "route")!;
    expect(route.tier).toBe("architect");
    expect(route.reason).toBe("tool calls failed 2 times with the default model, so the architect model takes over");
    // the model was given the external app's error text each time
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results[0]!.result).toMatchObject({ ok: false, output: "database unreachable" });
  });

  it("does not count errors from the built-in tools, a successful external call, or a denied permission", async () => {
    const { host } = await tools();
    // read_file fails (ENOENT) twice, an external call succeeds: none of that is the external app failing.
    const gw = new ScriptedGateway([call("1", "read_file", { path: "a" }), call("2", "read_file", { path: "b" }), call("3", "mcp__mock-mcp__echo", { text: "hi" }), text("done")]);
    const rt = new Runtime({ gateway: gw, tools: host, provider: "default", model: "builder-model", routing: cfg });
    await drain(rt.run({ mode: "agent", prompt: "look around" }));
    expect(new Set(models(gw))).toEqual(new Set(["default/builder-model"]));

    const denied = new ScriptedGateway([call("1", FAIL), call("2", FAIL), call("3", FAIL), text("done")]);
    const gated = new Runtime({ gateway: denied, tools: host, provider: "default", model: "builder-model", routing: cfg, gate: { check: async () => "deny" } as never });
    await drain(gated.run({ mode: "agent", prompt: "try the external tool" }));
    expect(new Set(models(denied))).toEqual(new Set(["default/builder-model"])); // refused by the permission gate: the app never said no
  });

  it("counts one step with several failing calls once, and starts the next run fresh", async () => {
    const { host } = await tools();
    const two: StreamEvent[] = [{ type: "tool_call", call: { id: "a", name: FAIL, args: {} } }, { type: "tool_call", call: { id: "b", name: FAIL, args: {} } }, done];
    const gw = new ScriptedGateway([two, text("gave up for now"), text("a new run")]);
    const rt = new Runtime({ gateway: gw, tools: host, provider: "default", model: "builder-model", routing: cfg });
    await drain(rt.run({ mode: "agent", prompt: "fix it" }));
    expect(models(gw)).toEqual(["default/builder-model", "default/builder-model"]); // one bad step is one failure, not two
    await drain(rt.run({ mode: "agent", prompt: "something else" }));
    expect(models(gw).at(-1)).toBe("default/builder-model");
  });
});
