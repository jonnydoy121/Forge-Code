// Phase 7 acceptance scenarios against the real runtime: scoped rules reach the prompt only for matching files,
// a long session survives compaction without losing the plan or the rules, the token meter stays within 5% of
// the provider's counts, and sub-agents keep the main thread clean.
import { describe, expect, it } from "vitest";
import type { AgentEvent, Message, ModelGateway, ModelRequest, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { READ_TOOLS, createToolHost, type FsBackend } from "@forge/tool-host";
import { RuleEngine, type ContextFs } from "@forge/context-store";
import { HookRunner, type Exec } from "@forge/verify";
import { Runtime, createSubAgentTool, estimateTokens, type ContextSection } from "../src";

const done = (inputTokens = 0): StreamEvent => ({ type: "done", usage: { inputTokens, outputTokens: 1, costUsd: 0 } });
const text = (t: string): StreamEvent => ({ type: "text", delta: t });
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });
const nofs: FsBackend = { readFile: async () => "file contents", readdir: async () => [] };
const tools = (extra = READ_TOOLS) => createToolHost({ root: "/r", fs: nofs, tools: extra });
async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const files: Record<string, string> = {
  "/r/AGENTS.md": "ROOT-RULE: use pnpm",
  "/r/.forge/rules/react.md": '---\ndescription: React conventions\nglobs: ["src/components/**/*.tsx"]\nactivation: auto\n---\nREACT-RULE: function components, named exports',
};
const fs: ContextFs = {
  read: async (p) => files[p] ?? null,
  list: async (d) => [...new Set(Object.keys(files).filter((k) => k.startsWith(d + "/")).map((k) => k.slice(d.length + 1).split("/")[0]!))],
};

/** The sections provider the app uses: rules for the active file, as a system-prompt section. */
function rulesSections(engine: RuleEngine, activeFile: () => string): () => Promise<ContextSection[]> {
  return async () => {
    const applied = await engine.applicable([activeFile()]);
    return applied.length ? [{ id: "rules", label: "Project rules", text: RuleEngine.render(applied), priority: 0 }] : [];
  };
}

describe("scoped rules are provably applied only to matching files", () => {
  async function systemPromptFor(file: string) {
    const gw = new ScriptedGateway([[text("ok"), done()]]);
    const rt = new Runtime({ gateway: gw, tools: tools(), provider: "p", model: "m", sections: rulesSections(new RuleEngine(fs, "/r"), () => file) });
    await drain(rt.run({ mode: "ask", prompt: "hello" }));
    return gw.requests[0]!.messages[0]!.content;
  }

  it("src/components/** rule reaches the model for a component file and not for server code", async () => {
    const inComponents = await systemPromptFor("src/components/Button.tsx");
    const inServer = await systemPromptFor("server/api.ts");
    expect(inComponents).toContain("REACT-RULE");
    expect(inComponents).toContain("ROOT-RULE"); // always-on repo rule still applies
    expect(inServer).not.toContain("REACT-RULE");
    expect(inServer).toContain("ROOT-RULE");
  });
});

describe("compaction", () => {
  const PLAN: ContextSection = { id: "plan", label: "Active plan", text: "PLAN: step 1 add csv, step 2 tests", priority: 1 };

  function longSession(opts: { hooks?: HookRunner; summarize?: (older: Message[], extra: string) => Promise<string> } = {}) {
    const engine = new RuleEngine(fs, "/r");
    const turns: StreamEvent[][] = [];
    // 14 turns of reading files then answering, each producing bulky tool output.
    for (let i = 0; i < 14; i++) turns.push([call(`c${i}`, "read_file", { path: `src/file${i}.ts` }), done()], [text(`Looked at file${i}. ${"analysis ".repeat(30)}`), done()]);
    const gw = new ScriptedGateway(turns);
    const big: FsBackend = { readFile: async (p) => `// ${p}\n` + "const filler = 'x';\n".repeat(150), readdir: async () => [] };
    const rt = new Runtime({
      gateway: gw,
      tools: createToolHost({ root: "/r", fs: big, tools: READ_TOOLS }),
      provider: "p",
      model: "m",
      sections: async () => [...(await rulesSections(engine, () => "src/components/Button.tsx")()), PLAN],
      budgetTokens: 6000,
      hooks: opts.hooks,
      compaction: { threshold: 0.8, keepRecent: 4, summarize: opts.summarize ?? (async (older) => `SUMMARY of ${older.length} messages. Open decisions: choose CSV delimiter.`) },
    });
    return { rt, gw };
  }

  it("a long session compacts, keeps rules and the plan in every request, and keeps working", async () => {
    const { rt, gw } = longSession();
    const compactions: Extract<AgentEvent, { type: "compaction" }>[] = [];
    for (let i = 0; i < 14; i++) {
      const ev = await drain(rt.run({ mode: "agent", prompt: `continue with file ${i}` }));
      for (const e of ev) if (e.type === "compaction") compactions.push(e);
    }
    expect(compactions.length).toBeGreaterThan(0);
    const c = compactions[0]!;
    expect(c.removedMessages).toBeGreaterThan(0);
    expect(c.tokensAfter).toBeLessThan(c.tokensBefore);
    expect(c.summary).toContain("Open decisions");
    expect(c.summary).toContain("Files read or changed so far: src/file");
    // after compaction the head of the history is the summary block
    expect(rt.history.some((m) => m.role === "user" && m.content.startsWith("[Summary of the earlier conversation"))).toBe(true);
    expect(rt.summaries.length).toBe(compactions.length);
    // EVERY request, before and after compaction, carried the rules and the plan
    for (const r of gw.requests) {
      const sys = r.messages[0]!.content;
      expect(sys).toContain("REACT-RULE");
      expect(sys).toContain("ROOT-RULE");
      expect(sys).toContain("PLAN: step 1 add csv");
    }
    // and the conversation never grew past the budget
    for (const r of gw.requests) expect(r.messages.reduce((n, m) => n + estimateTokens(m.content), 0)).toBeLessThan(6000);
    // history stays consistent: no tool message without its assistant call at the start
    expect(rt.history[0]!.role).not.toBe("tool");
  });

  it("fires PreCompact and PostCompact hooks, passing PreCompact output to the summariser", async () => {
    const seen: string[] = [];
    const exec: Exec = { run: async (_c, o) => (seen.push(o.env!.FORGE_EVENT!), { code: 0, stdout: o.env!.FORGE_EVENT === "PreCompact" ? "Preserve the migration decision." : "", stderr: "", timedOut: false, millis: 1 }) };
    const hooks = new HookRunner({ cwd: "/r", exec, config: { PreCompact: [{ command: "x" }], PostCompact: [{ command: "y" }] } });
    let extraSeen = "";
    const { rt } = longSession({ hooks, summarize: async (_o, extra) => ((extraSeen = extra), "S") });
    for (let i = 0; i < 6; i++) await drain(rt.run({ mode: "agent", prompt: `go ${i}` }));
    expect(seen).toContain("PreCompact");
    expect(seen).toContain("PostCompact");
    expect(extraSeen).toContain("Preserve the migration decision.");
  });

  it("summarises with the model by default, folding earlier summaries into the next one", async () => {
    const summarizerRequests: ModelRequest[] = [];
    const gw: ModelGateway = {
      async *stream(req) {
        if (req.tools && req.tools.length === 0 && req.messages[0]!.content.startsWith("You are compressing")) {
          summarizerRequests.push(req);
          yield text(`SUM#${summarizerRequests.length}`);
          yield done();
          return;
        }
        yield text("ok ".repeat(200));
        yield done();
      },
    };
    const rt = new Runtime({ gateway: gw, tools: tools(), provider: "p", model: "m", budgetTokens: 1500, compaction: { keepRecent: 2 } });
    for (let i = 0; i < 12; i++) await drain(rt.run({ mode: "ask", prompt: `question number ${i} about something ${"detail ".repeat(20)}` }));
    expect(summarizerRequests.length).toBeGreaterThanOrEqual(2);
    expect(summarizerRequests[0]!.messages[1]!.content).toContain("question number 0");
    // the second summary's input contains the first summary: nothing is lost across compactions
    expect(summarizerRequests[1]!.messages[1]!.content).toContain("SUM#1");
  });

  it("does nothing when there is room", async () => {
    const gw = new ScriptedGateway([[text("hi"), done()]]);
    const rt = new Runtime({ gateway: gw, tools: tools(), provider: "p", model: "m" });
    expect((await drain(rt.run({ mode: "ask", prompt: "hello" }))).some((e) => e.type === "compaction")).toBe(false);
  });
});

describe("token meter accuracy", () => {
  it("stays within 5% of the provider's reported input tokens once calibrated", async () => {
    // A provider whose tokenizer disagrees with our chars/4 estimate by a fixed 22% plus small jitter.
    const errors: number[] = [];
    // eslint-disable-next-line prefer-const
    let rt: Runtime;
    let turn = 0;
    const gw: ModelGateway = {
      async *stream(req) {
        const chars = req.messages.reduce((n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? []).length, 0) + JSON.stringify(req.tools ?? []).length;
        const jitter = 1 + (((turn * 7919) % 11) - 5) / 400; // within +-1.25%
        const reported = Math.round((chars / 4) * 0.78 * jitter);
        const predicted = rt.meter().total; // what the meter showed for this request, from earlier calibration
        if (turn >= 3) errors.push(Math.abs(predicted - reported) / reported);
        turn++;
        yield text("answer ".repeat(60));
        yield done(reported);
      },
    };
    rt = new Runtime({ gateway: gw, tools: tools(), provider: "p", model: "m" });
    for (let i = 0; i < 12; i++) {
      await drain(rt.run({ mode: "ask", prompt: `question ${i}: ${"explain the module in detail ".repeat(10 + i)}` }));
    }
    expect(errors.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...errors)).toBeLessThan(0.05);
    const m = rt.meter();
    expect(m.calibrated).toBe(true);
    expect(m.entries.reduce((n, e) => n + e.tokens, 0)).toBeGreaterThan(0);
  });

  it("falls back to the raw estimate when the provider reports no usage (local models)", async () => {
    const gw = new ScriptedGateway([[text("hi"), done(0)]]);
    const rt = new Runtime({ gateway: gw, tools: tools(), provider: "p", model: "m" });
    await drain(rt.run({ mode: "ask", prompt: "hello" }));
    expect(rt.meter()).toMatchObject({ calibrated: false, ratio: 1 });
  });
});

describe("sub-agents", () => {
  it("run in a fresh context and return only a report, keeping the main thread clean", async () => {
    const childGateway = new ScriptedGateway([
      [call("g1", "read_file", { path: "src/a.ts" }), done()],
      [text("working notes"), call("g2", "read_file", { path: "src/b.ts" }), done()],
      [text("Callers of X: src/a.ts:3 and src/b.ts:9."), done()],
    ]);
    const make = () => new Runtime({ gateway: childGateway, tools: tools(), provider: "p", model: "m" });
    const delegate = createSubAgentTool({ make });
    const parentGateway = new ScriptedGateway([[call("d", "delegate", { task: "find every caller of X" }), done()], [text("Two callers found."), done()]]);
    const parent = new Runtime({ gateway: parentGateway, tools: tools([...READ_TOOLS, delegate]), provider: "p", model: "m" });
    const events = await drain(parent.run({ mode: "ask", prompt: "who calls X?" }));

    const result = events.find((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")!;
    expect(result.result.output).toBe("Sub-agent report:\nCallers of X: src/a.ts:3 and src/b.ts:9.");
    // the child's file reads never entered the parent's conversation
    expect(JSON.stringify(parent.history)).not.toContain("file contents");
    expect(parent.history.filter((m) => m.role === "tool")).toHaveLength(1);
    // the child started from a fresh context: only its own task
    expect(childGateway.requests[0]!.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(childGateway.requests[0]!.messages.map((m) => m.content).join()).not.toContain("who calls X?");
    // the child cannot edit or delegate further
    expect(childGateway.requests[0]!.tools!.map((t) => t.name)).toEqual(["read_file", "ls", "grep"]);
  });

  it("reports early stops and empty reports honestly", async () => {
    const make = () => new Runtime({ gateway: new ScriptedGateway(Array.from({ length: 9 }, (_, i) => [call(`c${i}`, "ls", {}), done()])), tools: tools(), provider: "p", model: "m", limits: { maxSteps: 2 } });
    const out = await createSubAgentTool({ make }).run({ task: "explore" }, { root: "/r", fs: nofs });
    expect(out).toContain("stopped early: steps limit");
    await expect(createSubAgentTool({ make }).run({}, { root: "/r", fs: nofs })).rejects.toThrow("task");
  });
});
