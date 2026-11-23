// The agent loop in a "worker": the same MessageChannel protocol the app uses with a real Web Worker, exercised end to
// end. The host side owns the gateway, tools, permissions, sections and verification; the loop runs on the other side.
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, ModelGateway, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { READ_TOOLS, createEditTools, createToolHost, type FsBackend } from "@forge/tool-host";
import { HookRunner, type VerificationReport } from "@forge/verify";
import { RuntimeClient, serveRuntime, type Port, type RemoteHostDeps, type RuntimeConfig } from "../src/remote";

const done: StreamEvent = { type: "done", usage: { inputTokens: 100, outputTokens: 1, costUsd: 0.5 } };
const text = (t: string): StreamEvent => ({ type: "text", delta: t });
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });
const fs: FsBackend = { readFile: async (p) => `contents of ${p}`, readdir: async () => [] };

const opened: MessageChannel[] = [];
afterEach(() => opened.splice(0).forEach((c) => (c.port1.close(), c.port2.close())));

function connect(deps: Partial<RemoteHostDeps> & { gateway: ModelGateway }, config: Partial<RuntimeConfig> = {}) {
  const ch = new MessageChannel();
  opened.push(ch);
  serveRuntime(ch.port1 as unknown as Port);
  const tools = deps.tools ?? createToolHost({ root: "/r", fs, tools: READ_TOOLS });
  return new RuntimeClient(ch.port2 as unknown as Port, { ...deps, tools }, { provider: "p", model: "m", ...config });
}
async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("RuntimeClient over a worker-style port", () => {
  it("carries the routing config to the loop and the route event back: plan mode reaches the host addressed to the architect", async () => {
    const gw = new ScriptedGateway([[text("the plan"), done]]);
    const c = connect({ gateway: gw }, { routing: { architect: { provider: "architect", model: "big-model" }, scout: { provider: "scout", model: "small-model" } } });
    const events = await drain(c.run({ mode: "plan", prompt: "plan it" }));
    expect(gw.requests.map((r) => `${r.provider}/${r.model}`)).toEqual(["architect/big-model"]);
    expect(events.find((e) => e.type === "route")).toEqual({ type: "route", tier: "architect", provider: "architect", model: "big-model", reason: "plan mode" });
  });

  it("streams events, runs tools on the host, and mirrors history and cost afterwards", async () => {
    const gw = new ScriptedGateway([[call("1", "read_file", { path: "a.ts" }), done], [text("It reads a.ts."), done]]);
    const c = connect({ gateway: gw });
    const events = await drain(c.run({ mode: "ask", prompt: "what is a.ts?" }));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "done", "tool_result", "text", "done"]);
    const tr = events.find((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")!;
    expect(tr.result.output).toBe("1\tcontents of /r/a.ts");
    expect(c.history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(c.costUsd).toBe(1);
    expect(c.running).toBe(false);
    expect(c.meter().calibrated).toBe(true);
    // the model saw exactly the tools the host exposes for this mode
    expect(gw.requests[0]!.tools!.map((t) => t.name)).toEqual(["read_file", "ls", "grep", "find_files"]);
  });

  it("mode enforcement still comes from the host: write tools are never offered in ask mode", async () => {
    const edit = createEditTools({ read: async () => "x", propose: async () => ({ status: "pending", added: 1, removed: 0 }) });
    const gw = new ScriptedGateway([[call("1", "edit_file", { path: "a.ts", old_string: "x", new_string: "y" }), done], [text("ok"), done]]);
    const c = connect({ gateway: gw, tools: createToolHost({ root: "/r", fs, tools: [...READ_TOOLS, ...edit] }) });
    const events = await drain(c.run({ mode: "ask", prompt: "edit it" }));
    expect(gw.requests[0]!.tools!.map((t) => t.name)).not.toContain("edit_file");
    expect((events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>).result.output).toContain("not available in ask mode");
  });

  it("proxies the permission gate, context sections and mode prompts; secrets are redacted before the host sees them", async () => {
    const asked: string[] = [];
    const gw = new ScriptedGateway([[call("1", "read_file", { path: "k.ts" }), done], [text("ok"), done]]);
    const c = connect({
      gateway: gw,
      gate: { check: async (_cls, cl) => (asked.push(cl.name), "deny" as const) },
      sections: async () => [{ id: "s", label: "Attachment", priority: 2, text: "key sk-ant-api03-abcdefghijklmnopqrstuvwx" }],
      modePrompt: (m) => (m === "plan" ? "PLAN MODE TEXT" : undefined),
    });
    const events = await drain(c.run({ mode: "plan", prompt: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 please" }));
    expect(asked).toEqual(["read_file"]);
    expect((events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>).result.output).toContain("denied");
    const sent = JSON.stringify(gw.requests);
    expect(sent).toContain("PLAN MODE TEXT");
    expect(sent).toContain("Attachment");
    expect(sent).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwx");
    expect(sent).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  it("aborting stops the run and the in-flight model stream", async () => {
    let streamAborted = false;
    const gw: ModelGateway = {
      async *stream(req) {
        req.signal?.addEventListener("abort", () => (streamAborted = true));
        yield text("starting ");
        await new Promise((r) => setTimeout(r, 400));
        yield text("never");
        yield done;
      },
    };
    const c = connect({ gateway: gw });
    const ac = new AbortController();
    const run = (async () => {
      for await (const e of c.run({ mode: "ask", prompt: "x", signal: ac.signal })) if (e.type === "text") ac.abort();
    })();
    await run.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(streamAborted).toBe(true);
    expect(c.running).toBe(false);
  });

  it("verification runs on the host and its structured feedback drives the loop in the worker", async () => {
    const failing: VerificationReport = { phase: "fast", attempt: 1, checks: [{ kind: "test", command: "t", ok: false, durationMs: 1, errors: [{ message: "adds is wrong", severity: "error", test: "adds" }], omitted: 0 }], testsAdded: [], testsChanged: [], unverified: [], verified: false, summary: "Failed" };
    const passing: VerificationReport = { ...failing, checks: [{ ...failing.checks[0]!, ok: true, errors: [] }], summary: "ok" };
    const edit = createEditTools({ read: async () => "a", propose: async () => ({ status: "applied", added: 1, removed: 1, checkpoint: "cp" }) });
    const gw = new ScriptedGateway([[call("1", "edit_file", { path: "a.ts", old_string: "a", new_string: "b" }), done], [text("fixing"), call("2", "edit_file", { path: "a.ts", old_string: "a", new_string: "c" }), done], [text("done"), done]]);
    let n = 0;
    const c = connect({
      gateway: gw,
      tools: createToolHost({ root: "/r", fs, tools: [...READ_TOOLS, ...edit] }),
      verify: { enabled: () => true, maxAttempts: 3, root: "/r", run: async (_t, phase) => (n++ === 0 ? failing : { ...passing, phase }) },
    });
    const events = await drain(c.run({ mode: "agent", prompt: "fix" }));
    expect(events.filter((e) => e.type === "verify").length).toBeGreaterThanOrEqual(2);
    expect(gw.requests[1]!.messages.at(-1)!.content).toContain("Automated checks failed (attempt 1 of 3)");
    expect(gw.requests[1]!.messages.at(-1)!.content).toContain("adds is wrong");
  });

  it("propagates errors with their retryable flag (policy refusals are not retried)", async () => {
    const gw: ModelGateway = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw Object.assign(new Error("Blocked: local-only"), { name: "LocalOnlyError", retryable: false });
          },
        }),
      }),
    };
    const c = connect({ gateway: gw });
    const err = await drain(c.run({ mode: "ask", prompt: "x" })).catch((e) => e as Error & { retryable?: boolean });
    expect(err).toMatchObject({ name: "LocalOnlyError", message: "Blocked: local-only", retryable: false });
  });

  it("restoring history and adding cost propagate to the worker; session start and hooks are proxied", async () => {
    const seen: string[] = [];
    const exec = { run: async (_c: string, o: { env?: Record<string, string> }) => (seen.push(o.env!.FORGE_EVENT!), { code: 0, stdout: "hello from hook", stderr: "", timedOut: false, millis: 1 }) };
    const hooks = new HookRunner({ cwd: "/r", exec, config: { SessionStart: [{ command: "x" }] } });
    const gw = new ScriptedGateway([[text("ok"), done]]);
    const c = connect({ gateway: gw, hooks });
    const started = await c.sessionStart();
    expect(started).toMatchObject({ type: "hook", event: "SessionStart", output: "hello from hook" });
    c.setHistory([{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }]);
    c.addCost(1);
    await drain(c.run({ mode: "ask", prompt: "next" }));
    expect(gw.requests[0]!.messages.map((m) => m.content)).toEqual(expect.arrayContaining(["earlier question", "earlier answer", "next"]));
    expect(c.costUsd).toBe(1.5);
    expect(seen).toEqual(["SessionStart"]);
  });

  it("adding cost mid-run (a sub-agent finishing) never clobbers the worker's live conversation", async () => {
    const ref: { c?: RuntimeClient } = {};
    const tools = createToolHost({
      root: "/r",
      fs,
      tools: [{ spec: { name: "delegate", description: "d", class: "read", parameters: { type: "object", properties: {} } }, run: async () => (ref.c!.addCost(0.25), { ok: true, output: "report" }) }],
    });
    const gw = new ScriptedGateway([[call("1", "delegate", {}), done], [text("fin"), done]]);
    const c = (ref.c = connect({ gateway: gw, tools }));
    c.setHistory([{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }]);
    await drain(c.run({ mode: "ask", prompt: "new question" }));
    const second = gw.requests[1]!.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(second).toEqual(["old question", "new question"]);
    expect(c.costUsd).toBe(1.25);
  });
});
