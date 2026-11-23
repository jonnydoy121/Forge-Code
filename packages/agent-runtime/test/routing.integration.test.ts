import { describe, expect, it } from "vitest";
import type { AgentEvent, Message, ModelGateway, ModelRequest, StreamEvent, ToolHost } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import type { VerificationReport } from "@forge/verify";
import { Runtime, type RoutingConfig } from "../src";

const usage = (costUsd = 0): StreamEvent => ({ type: "done", usage: { inputTokens: 100, outputTokens: 10, costUsd } });
const text = (t: string, cost = 0): StreamEvent[] => [{ type: "text", delta: t }, usage(cost)];
const edit = (id: string, cost = 0): StreamEvent[] => [{ type: "tool_call", call: { id, name: "edit_file", args: { path: "src/a.ts" } } }, usage(cost)];

const tools: ToolHost = {
  listTools: () => [{ name: "edit_file", description: "e", parameters: { type: "object" }, class: "write" }],
  call: async (_mode, c) => ({ id: c.id, ok: true, output: "edited", touched: [{ path: "/ws/src/a.ts", created: false, applied: true }] }),
};

const report = (ok: boolean, phase: "fast" | "full", attempt: number): VerificationReport => ({
  phase,
  attempt,
  checks: [{ kind: "test", command: "npm test", ok, durationMs: 1, errors: ok ? [] : [{ message: "expected 2, got 1", severity: "error", file: "src/a.ts" }], omitted: 0 }],
  testsAdded: [],
  testsChanged: [],
  unverified: [],
  verified: ok && phase === "full",
  summary: ok ? "ok" : "failed",
});

const cfg: RoutingConfig = { scout: { provider: "scout", model: "scout-model" }, architect: { provider: "architect", model: "architect-model" } };

/** Verification that fails its first `failures` runs and then passes. */
const verifyFailing = (failures: number) => {
  let n = 0;
  return { enabled: () => true, maxAttempts: 6, root: "/ws", run: async (_t: unknown, phase: "fast" | "full", attempt: number) => report(++n > failures, phase, attempt) };
};

async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const routes = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: "route" }> => e.type === "route");
const used = (gw: ScriptedGateway) => gw.requests.map((r) => `${r.provider}/${r.model}`);
const make = (gw: ModelGateway, extra: Partial<ConstructorParameters<typeof Runtime>[0]> = {}) => new Runtime({ gateway: gw, tools, provider: "default", model: "builder-model", ...extra });

describe("escalation: the builder gets one fix attempt, the architect the second", () => {
  it("stays on the builder for the first failed check, escalates on the second, and keeps the architect until the run ends", async () => {
    const gw = new ScriptedGateway([edit("c1", 0.1), edit("c2", 0.1), edit("c3", 1), text("done", 1)]);
    const rt = make(gw, { routing: cfg, verify: verifyFailing(2) });
    const events = await drain(rt.run({ mode: "agent", prompt: "make the test pass" }));
    expect(used(gw)).toEqual(["default/builder-model", "default/builder-model", "architect/architect-model", "architect/architect-model"]);
    expect(routes(events)).toHaveLength(1); // announced once, when it happens
    expect(routes(events)[0]).toMatchObject({ tier: "architect", provider: "architect", model: "architect-model" });
    expect(routes(events)[0]!.reason).toContain("2 times");
    expect(rt.costUsd).toBeCloseTo(2.2); // each request is costed by the model that answered it
  });

  it("starts the next run on the builder again", async () => {
    const gw = new ScriptedGateway([edit("c1"), edit("c2"), text("ok"), text("second run")]);
    const rt = make(gw, { routing: cfg, verify: verifyFailing(2) });
    await drain(rt.run({ mode: "agent", prompt: "fix it" }));
    const before = gw.requests.length;
    await drain(rt.run({ mode: "agent", prompt: "something else" }));
    expect(used(gw).slice(before)).toEqual(["default/builder-model"]);
  });

  it("never switches model when routing is not configured, and says nothing about it", async () => {
    const gw = new ScriptedGateway([edit("c1"), edit("c2"), edit("c3"), text("done")]);
    const rt = make(gw, { verify: verifyFailing(2) });
    const events = await drain(rt.run({ mode: "agent", prompt: "fix it" }));
    expect(new Set(used(gw))).toEqual(new Set(["default/builder-model"]));
    expect(routes(events)).toEqual([]);
  });

  it("keeps trying with the builder when no architect is set", async () => {
    const gw = new ScriptedGateway([edit("c1"), edit("c2"), edit("c3"), text("done")]);
    const rt = make(gw, { routing: { scout: cfg.scout }, verify: verifyFailing(2) });
    const events = await drain(rt.run({ mode: "agent", prompt: "fix it" }));
    expect(new Set(used(gw))).toEqual(new Set(["default/builder-model"]));
    expect(routes(events)).toEqual([]);
  });

  it("does not escalate to a tier that local-only mode has disabled", async () => {
    const gw = new ScriptedGateway([edit("c1"), edit("c2"), edit("c3"), text("done")]);
    const rt = make(gw, { routing: { ...cfg, disabled: ["architect"] }, verify: verifyFailing(2) });
    await drain(rt.run({ mode: "agent", prompt: "fix it" }));
    expect(new Set(used(gw))).toEqual(new Set(["default/builder-model"]));
  });

  it("audits the model that actually answered", async () => {
    const audited: string[] = [];
    const gw = new ScriptedGateway([edit("c1"), edit("c2"), edit("c3"), text("done")]);
    const rt = make(gw, { routing: cfg, verify: verifyFailing(2), audit: (e) => e.kind === "model" && audited.push(e.name) });
    await drain(rt.run({ mode: "agent", prompt: "fix it" }));
    expect(audited).toEqual(["default/builder-model", "default/builder-model", "architect/architect-model", "architect/architect-model"]);
  });
});

describe("plan mode and triage", () => {
  it("answers plan mode with the architect", async () => {
    const gw = new ScriptedGateway([text("the plan")]);
    const events = await drain(make(gw, { routing: cfg }).run({ mode: "plan", prompt: "plan the migration" }));
    expect(used(gw)).toEqual(["architect/architect-model"]);
    expect(routes(events)[0]).toMatchObject({ tier: "architect", reason: "plan mode" });
  });

  it("does nothing with the wording of a request unless triage is turned on", async () => {
    const gw = new ScriptedGateway([text("a")]);
    await drain(make(gw, { routing: cfg }).run({ mode: "ask", prompt: "What does the retry helper do?" }));
    expect(used(gw)).toEqual(["default/builder-model"]);
  });

  it("with heuristic triage, sends a short question to the scout and an ordinary request to the builder", async () => {
    const gw = new ScriptedGateway([text("a"), text("b")]);
    const rt = make(gw, { routing: { ...cfg, triage: "heuristic" } });
    const events = await drain(rt.run({ mode: "ask", prompt: "What does the retry helper do?" }));
    await drain(rt.run({ mode: "agent", prompt: "Add a --verbose flag to the CLI and print each step" }));
    expect(used(gw)).toEqual(["scout/scout-model", "default/builder-model"]);
    expect(routes(events)[0]).toMatchObject({ tier: "scout", reason: "the request looks simple" });
  });

  it("with model triage, asks the scout first and follows its answer", async () => {
    for (const [answer, expected] of [["trivial", "scout/scout-model"], ["complex", "architect/architect-model"], ["standard", "default/builder-model"]] as const) {
      const gw = new ScriptedGateway([text(answer), text("the real answer")]);
      await drain(make(gw, { routing: { ...cfg, triage: "model" } }).run({ mode: "agent", prompt: "Add a --verbose flag to the CLI" }));
      expect(gw.requests[0]).toMatchObject({ provider: "scout", model: "scout-model" }); // the triage call itself
      expect(gw.requests[0]!.messages[0]!.content).toContain("Reply with exactly one word");
      expect(gw.requests[0]!.tools).toBeUndefined();
      expect(`${gw.requests[1]!.provider}/${gw.requests[1]!.model}`, answer).toBe(expected);
    }
  });

  it("falls back to the heuristic when the scout rambles, fails, or there is no scout", async () => {
    // rambling: not one of the three words -> heuristic says a short question is trivial
    const rambling = new ScriptedGateway([text("hmm, hard to say really"), text("answer")]);
    await drain(make(rambling, { routing: { ...cfg, triage: "model" } }).run({ mode: "ask", prompt: "What does the retry helper do?" }));
    expect(used(rambling)[1]).toBe("scout/scout-model");

    // the scout call throws -> heuristic, and the run still completes
    const calls: ModelRequest[] = [];
    const failing: ModelGateway = {
      async *stream(req) {
        calls.push(req);
        if (req.provider === "scout" && calls.length === 1) throw new Error("scout is down");
        yield* text("fine");
      },
    };
    const events = await drain(make(failing, { routing: { ...cfg, triage: "model" } }).run({ mode: "agent", prompt: "Add a --verbose flag to the CLI" }));
    expect(calls.map((c) => c.provider)).toEqual(["scout", "default"]);
    expect(events.some((e) => e.type === "text")).toBe(true);

    // triage "model" with no scout set: no extra call at all
    const noScout = new ScriptedGateway([text("answer")]);
    await drain(make(noScout, { routing: { architect: cfg.architect, triage: "model" } }).run({ mode: "ask", prompt: "What does it do?" }));
    expect(noScout.requests).toHaveLength(1);
  });

  it("stops waiting for a slow scout after a couple of seconds and answers with the heuristic", async () => {
    const slow: ModelGateway = {
      async *stream(req) {
        if (req.provider === "scout" && req.tools === undefined && req.messages[0]!.content.includes("exactly one word")) {
          await new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        yield* text("answer");
      },
    };
    const t0 = Date.now();
    const events = await drain(make(slow, { routing: { ...cfg, triage: "model" } }).run({ mode: "agent", prompt: "Add a --verbose flag to the CLI" }));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(events.some((e) => e.type === "text")).toBe(true);
  }, 10_000);
});

describe("chores go to the scout", () => {
  const long: Message[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i} ${"x".repeat(400)}` }));

  it("summarises older turns with the scout model, then continues with the builder", async () => {
    const gw = new ScriptedGateway([text("SUMMARY of the earlier turns"), text("carrying on")]);
    const rt = make(gw, { routing: cfg, compaction: { keepRecent: 2, threshold: 0.0001 } });
    rt.setHistory([...long]);
    await drain(rt.run({ mode: "ask", prompt: "continue" }));
    expect(used(gw)).toEqual(["scout/scout-model", "default/builder-model"]);
    expect(gw.requests[0]!.tools ?? []).toEqual([]); // a summary needs no tools
    expect(rt.summaries.at(-1)).toContain("SUMMARY");
  });

  it("uses the builder for the summary when there is no scout", async () => {
    const gw = new ScriptedGateway([text("SUMMARY"), text("carrying on")]);
    const rt = make(gw, { routing: { architect: cfg.architect }, compaction: { keepRecent: 2, threshold: 0.0001 } });
    rt.setHistory([...long]);
    await drain(rt.run({ mode: "ask", prompt: "continue" }));
    expect(used(gw)).toEqual(["default/builder-model", "default/builder-model"]);
  });
});
