import { describe, expect, it } from "vitest";
import type { AgentEvent, Message, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { createToolHost, readFileTool, type FsBackend, type RegisteredTool } from "@forge/tool-host";
import { Runtime, assembleContext, estimateTokens } from "../src";

const usage = (costUsd = 0): StreamEvent => ({ type: "done", usage: { inputTokens: 1, outputTokens: 1, costUsd } });
const fs: FsBackend = {
  readFile: async (p) => (p.endsWith("a.ts") ? "export const a = 1;\n" : Promise.reject(new Error("ENOENT"))),
  readdir: async () => [],
};
const host = (tools = [readFileTool]) => createToolHost({ root: "/ws", fs, tools });
const collect = async (it: AsyncIterable<AgentEvent>) => {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });

describe("Runtime loop", () => {
  it("runs tool calls, feeds results back, and stops when the model stops calling tools", async () => {
    const gw = new ScriptedGateway([
      [{ type: "text", delta: "Let me look. " }, call("c1", "read_file", { path: "a.ts" }), usage()],
      [{ type: "text", delta: "a is 1." }, usage()],
    ]);
    const rt = new Runtime({ gateway: gw, tools: host(), provider: "p", model: "m" });
    const events = await collect(rt.run({ mode: "ask", prompt: "what is a?" }));
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
    // second request carries the assistant tool call and the tool result
    const second = gw.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(second[3]).toMatchObject({ toolCallId: "c1", content: "1\texport const a = 1;\n2\t" });
    expect(gw.requests[0]!.tools?.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("surfaces tool errors to the model instead of throwing", async () => {
    const gw = new ScriptedGateway([[call("c1", "read_file", { path: "missing.ts" }), usage()], [usage()]]);
    const rt = new Runtime({ gateway: gw, tools: host(), provider: "p", model: "m" });
    const events = await collect(rt.run({ mode: "ask", prompt: "x" }));
    const tr = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(tr.result.ok).toBe(false);
  });

  it("does not expose or run write tools in ask mode", async () => {
    let wrote = false;
    const write: RegisteredTool = {
      spec: { name: "write_file", description: "w", parameters: { type: "object" }, class: "write" },
      run: async () => ((wrote = true), "ok"),
    };
    const gw = new ScriptedGateway([[call("c1", "write_file", {}), usage()], [usage()]]);
    const rt = new Runtime({ gateway: gw, tools: host([readFileTool, write]), provider: "p", model: "m" });
    await collect(rt.run({ mode: "ask", prompt: "x" }));
    expect(gw.requests[0]!.tools?.map((t) => t.name)).toEqual(["read_file"]);
    expect(wrote).toBe(false);
  });

  it("honours the permission gate", async () => {
    const gw = new ScriptedGateway([[call("c1", "read_file", { path: "a.ts" }), usage()], [usage()]]);
    const rt = new Runtime({ gateway: gw, tools: host(), provider: "p", model: "m", gate: { check: () => "deny" } });
    const events = await collect(rt.run({ mode: "ask", prompt: "x" }));
    expect((events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>).result.output).toContain("denied");
  });

  it("stops at the step limit and the cost limit", async () => {
    const loop = () => new ScriptedGateway(Array.from({ length: 10 }, () => [call("c", "read_file", { path: "a.ts" }), usage(1)]));
    const steps = await collect(new Runtime({ gateway: loop(), tools: host(), provider: "p", model: "m", limits: { maxSteps: 3, maxCostUsd: 100 } }).run({ mode: "ask", prompt: "x" }));
    expect(steps.at(-1)).toEqual({ type: "limit", reason: "steps" });
    const cost = await collect(new Runtime({ gateway: loop(), tools: host(), provider: "p", model: "m", limits: { maxSteps: 50, maxCostUsd: 2 } }).run({ mode: "ask", prompt: "x" }));
    expect(cost.at(-1)).toEqual({ type: "limit", reason: "cost" });
  });

  it("redacts secrets in tool output before the model sees them", async () => {
    const leaky: FsBackend = { readFile: async () => 'const apiKey = "abcd1234efgh5678";', readdir: async () => [] };
    const gw = new ScriptedGateway([[call("c1", "read_file", { path: "cfg.ts" }), usage()], [usage()]]);
    const rt = new Runtime({ gateway: gw, tools: createToolHost({ root: "/ws", fs: leaky }), provider: "p", model: "m" });
    await collect(rt.run({ mode: "ask", prompt: "x" }));
    expect(JSON.stringify(gw.requests[1]!.messages)).not.toContain("abcd1234efgh5678");
  });

  it("stops when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const rt = new Runtime({ gateway: new ScriptedGateway([]), tools: host(), provider: "p", model: "m" });
    expect((await collect(rt.run({ mode: "ask", prompt: "x", signal: ac.signal }))).at(-1)).toEqual({ type: "limit", reason: "aborted" });
  });
});

describe("assembleContext", () => {
  const hist = (n: number): Message[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(400) }) as Message);
  const sec = (id: string, priority: number, chars: number) => ({ id, label: id, priority, text: "y".repeat(chars) });

  it("keeps everything when under budget and meters each part", () => {
    const c = assembleContext({ base: "base", sections: [sec("rules", 0, 400), sec("map", 3, 400)], history: hist(3), budget: 10_000 });
    expect(c.meter.map((m) => m.id)).toEqual(["system", "rules", "map", "conversation"]);
    expect(c.meter.every((m) => !m.trimmed)).toBe(true);
    const sum = c.meter.reduce((n, m) => n + m.tokens, 0);
    expect(Math.abs(c.totalTokens - sum) / c.totalTokens).toBeLessThan(0.05);
  });

  it("trims lowest priority first and always keeps rules and the newest user message", () => {
    const c = assembleContext({
      base: "base",
      sections: [sec("retrieved", 4, 4000), sec("rules", 0, 400), sec("plan", 1, 400)],
      history: hist(7),
      budget: 400,
    });
    expect(c.system).toContain("rules");
    expect(c.system).toContain("plan");
    expect(c.meter.find((m) => m.id === "retrieved")!.trimmed).toBe(true);
    expect(c.history.at(-1)!.role).toBe("user");
    expect(estimateTokens(c.system)).toBeLessThan(400);
  });

  it("never starts the kept history with an orphaned tool result", () => {
    const history: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "ls", args: {} }] },
      { role: "tool", toolCallId: "1", content: "z".repeat(2000) },
      { role: "user", content: "again" },
    ];
    const c = assembleContext({ base: "b", sections: [], history, budget: 600 });
    expect(c.history[0]!.role).not.toBe("tool");
  });
});
