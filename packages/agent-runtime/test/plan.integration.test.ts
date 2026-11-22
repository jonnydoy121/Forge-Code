// Phase 6 exit scenario, with real files: Plan mode writes only the plan; Build executes it step by step with
// step-tagged changes and live status; out-of-plan edits are blocked and surfaced.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { READ_TOOLS, createEditTools, createToolHost } from "@forge/tool-host";
import { nodeFs } from "@forge/tool-host/src/node-fs";
import { FileCheckpointStore } from "@forge/checkpoints";
import { nodeCheckpointFs } from "@forge/checkpoints/src/node";
import { PendingChanges } from "@forge/review";
import { PlanExecutor, PlanGuard, PlanStore, createPlanTools, modePrompt, parsePlan } from "@forge/plans";
import { Runtime } from "../src";

let root: string;
const PLAN = `---
title: Add greeting
status: approved
---
# Add greeting

## Goal
The app can greet a user by name.

## Files to change
- \`greet.js\` — add the greeting function

## Files to create
- \`greet.test.js\` — tests for it

## Tasks
1. [ ] **Add greet()** — acceptance: greet('Ada') returns 'Hello, Ada'
   - files: greet.js
2. [ ] **Test it** — acceptance: node --test passes
   - files: greet.test.js

## Risks
- None known.

## Out of scope
- Localisation
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-plan-")).replace(/\\/g, "/");
  writeFileSync(`${root}/greet.js`, "export const greet = (n) => n;\n");
  writeFileSync(`${root}/other.js`, "export const keep = 1;\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const done: StreamEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });
const text = (t: string): StreamEvent => ({ type: "text", delta: t });
async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function build(turns: StreamEvent[][], opts: { addFile?: boolean; questions?: string[] } = {}) {
  const store = new PlanStore(nodeCheckpointFs, root);
  const checkpoints = new FileCheckpointStore({ fs: nodeCheckpointFs, dir: `${root}/.forge/checkpoints/p` });
  const pending = new PendingChanges({ fs: nodeCheckpointFs, checkpoints, mode: () => "auto" });
  const asked: string[] = [];
  const blocked: string[] = [];
  const guard = new PlanGuard({ store, askAddFile: async (q) => (asked.push(q), opts.addFile ?? false), onBlocked: (p) => blocked.push(p) }, root);
  const sink = {
    read: async (p: string) => (pending.effective(p) !== undefined ? pending.effective(p)! : nodeCheckpointFs.read(p)),
    propose: async (p: string, c: string | null, r: string) => {
      const o = await pending.propose(p, c, r);
      return { status: o.status, added: o.stats.added, removed: o.stats.removed, checkpoint: o.checkpoint, created: o.created };
    },
    authorize: (p: string) => guard.authorize(p),
  };
  const planTools = createPlanTools({ store, askUser: async (qs) => (opts.questions ?? qs.map((q) => q.default ?? "")) });
  const tools = createToolHost({ root, fs: nodeFs, tools: [...READ_TOOLS, ...planTools, ...createEditTools(sink)] });
  const gateway = new ScriptedGateway(turns);
  const runtime = new Runtime({ gateway, tools, provider: "p", model: "m", modePrompt });
  return { store, checkpoints, pending, guard, runtime, gateway, asked, blocked };
}

describe("Plan mode", () => {
  it("researches, asks, writes only the plan file, and cannot edit code", async () => {
    const t = build(
      [
        [call("1", "read_file", { path: "greet.js" }), done],
        [call("2", "ask_user", { questions: [{ question: "Greeting language?", default: "English" }] }), done],
        // a hallucinated edit in plan mode must go nowhere
        [call("3", "edit_file", { path: "greet.js", old_string: "n", new_string: "m" }), call("4", "write_plan", { markdown: PLAN }), done],
        [text("Plan written. Please review it."), done],
      ],
      { questions: ["English"] },
    );
    const events = await drain(t.runtime.run({ mode: "plan", prompt: "Add a greeting feature" }));

    // tool exposure: read + plan tools only
    expect(t.gateway.requests[0]!.tools!.map((x) => x.name).sort()).toEqual(["ask_user", "grep", "ls", "read_file", "write_plan"]);
    expect(t.gateway.requests[0]!.messages[0]!.content).toContain("PLAN mode");
    expect(t.gateway.requests[0]!.messages[0]!.content).toContain("## Tasks");

    // the edit was refused by the host, the plan was written, code untouched
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.find((r) => r.name === "edit_file")!.result.output).toContain("not available in plan mode");
    expect(readFileSync(`${root}/greet.js`, "utf8")).toBe("export const greet = (n) => n;\n");
    expect(existsSync(`${root}/.forge/plans/add-greeting.md`)).toBe(true);
    expect(parsePlan(readFileSync(`${root}/.forge/plans/add-greeting.md`, "utf8")).steps).toHaveLength(2);
    expect(results.find((r) => r.name === "ask_user")!.result.output).toBe("Q: Greeting language?\nA: English");
  });
});

describe("Build", () => {
  async function seedPlan(t: ReturnType<typeof build>) {
    return t.store.write(PLAN);
  }
  it("executes steps in order, tags changes with the step number, and updates the plan file as it goes", async () => {
    const t = build([
      [call("a", "edit_file", { path: "greet.js", old_string: "(n) => n", new_string: "(n) => `Hello, ${n}`", reason: "greeting" }), done],
      [text("Step 1 done."), done],
      [call("b", "write_file", { path: "greet.test.js", content: "// tests\n", reason: "tests" }), done],
      [text("Step 2 done."), done],
    ]);
    const slug = await seedPlan(t);
    t.guard.activate(slug, 1);
    const log: string[] = [];
    const ex = new PlanExecutor({
      store: t.store,
      onProgress: (_s, p) => log.push(p.steps.map((s) => s.status).join(",")),
      beginChangeSet: (label, n) => (t.pending.beginChangeSet(label, n), t.guard.setStep(n)),
      runStep: async (_s, prompt) => (await drain(t.runtime.run({ mode: "agent", prompt })), { ok: true }),
    });
    expect(await ex.build(slug)).toEqual({ status: "done" });

    expect(readFileSync(`${root}/greet.js`, "utf8")).toContain("Hello, ${n}");
    expect(existsSync(`${root}/greet.test.js`)).toBe(true);
    // each step's checkpoint carries its step number: rollback by step restores just that step
    expect((await t.checkpoints.list()).map((c) => c.step)).toEqual([1, 2]);
    // live tracking, visible to the UI at every transition
    expect(log).toContain("in-progress,pending");
    expect(log).toContain("verified,in-progress");
    expect(log.at(-1)).toBe("verified,verified");
    expect(parsePlan(readFileSync(`${root}/.forge/plans/add-greeting.md`, "utf8")).status).toBe("done");
    // each step's prompt told the agent to do that step only
    expect(t.gateway.requests[0]!.messages.find((m) => m.role === "user")!.content).toContain("Execute step 1 of 2");
    expect(t.gateway.requests[2]!.messages.filter((m) => m.role === "user").at(-1)!.content).toContain("Execute step 2 of 2");

    await t.checkpoints.rollback({ step: 2 });
    expect(existsSync(`${root}/greet.test.js`)).toBe(false);
    expect(readFileSync(`${root}/greet.js`, "utf8")).toContain("Hello"); // step 1 untouched
  });

  it("blocks an out-of-plan edit, surfaces it, and keeps the file unchanged when the developer declines", async () => {
    const t = build(
      [
        [call("a", "edit_file", { path: "other.js", old_string: "keep = 1", new_string: "keep = 2" }), done],
        [call("b", "edit_file", { path: "greet.js", old_string: "(n) => n", new_string: "(n) => `Hi ${n}`" }), done],
        [text("done"), done],
        [text("step 2"), done],
      ],
      { addFile: false },
    );
    const slug = await seedPlan(t);
    t.guard.activate(slug, 1);
    const events = await drain(t.runtime.run({ mode: "agent", prompt: "execute step 1" }));
    const first = (events.filter((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>[])[0]!;
    expect(first.result.ok).toBe(false);
    expect(first.result.output).toContain("not in the approved plan");
    expect(t.asked).toEqual(["Step 1 also needs other.js. Add it to the plan?"]);
    expect(t.blocked).toEqual(["other.js"]);
    expect(readFileSync(`${root}/other.js`, "utf8")).toBe("export const keep = 1;\n");
    // in-plan edits still work in the same run
    expect(readFileSync(`${root}/greet.js`, "utf8")).toContain("Hi ${n}");
  });

  it("applies the out-of-plan edit after approval and records the file in the plan", async () => {
    const t = build([[call("a", "edit_file", { path: "other.js", old_string: "keep = 1", new_string: "keep = 2" }), done], [text("done"), done]], { addFile: true });
    const slug = await seedPlan(t);
    t.guard.activate(slug, 1);
    await drain(t.runtime.run({ mode: "agent", prompt: "execute step 1" }));
    expect(readFileSync(`${root}/other.js`, "utf8")).toBe("export const keep = 2;\n");
    expect((await t.store.read(slug))!.plan.filesToChange.map((f) => f.path)).toContain("other.js");
  });

  it("with no plan active the guard does not interfere", async () => {
    const t = build([[call("a", "edit_file", { path: "other.js", old_string: "keep = 1", new_string: "keep = 3" }), done], [text("ok"), done]]);
    await drain(t.runtime.run({ mode: "agent", prompt: "tweak other.js" }));
    expect(readFileSync(`${root}/other.js`, "utf8")).toContain("keep = 3");
    expect(t.asked).toEqual([]);
  });

  it("a failed step stops the build, marks it failed, and a later build resumes from it", async () => {
    const t = build([
      [text("could not do it"), done], // step 1 attempt 1: the executor will be told it failed
      [call("a", "edit_file", { path: "greet.js", old_string: "(n) => n", new_string: "(n) => `Hello, ${n}`" }), done],
      [text("step 1 done"), done],
      [call("b", "write_file", { path: "greet.test.js", content: "// t\n" }), done],
      [text("step 2 done"), done],
    ]);
    const slug = await seedPlan(t);
    t.guard.activate(slug, 1);
    let attempt = 0;
    const ex = new PlanExecutor({
      store: t.store,
      beginChangeSet: (l, n) => (t.pending.beginChangeSet(l, n), t.guard.setStep(n)),
      runStep: async (_s, prompt) => {
        await drain(t.runtime.run({ mode: "agent", prompt }));
        return attempt++ === 0 ? { ok: false, reason: "acceptance check failed" } : { ok: true };
      },
    });
    expect(await ex.build(slug)).toEqual({ status: "failed", step: 1, reason: "acceptance check failed" });
    let plan = (await t.store.read(slug))!.plan;
    expect([plan.status, plan.steps[0]!.status, plan.steps[1]!.status]).toEqual(["paused", "failed", "pending"]);
    expect(await ex.build(slug)).toEqual({ status: "done" });
    plan = (await t.store.read(slug))!.plan;
    expect(plan.status).toBe("done");
  });
});
