// Phase 5 exit scenario with real files and a real test runner (node --test): the agent fixes a seeded failing
// test through the verify-fix loop without weakening the test.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { READ_TOOLS, createEditTools, createToolHost } from "@forge/tool-host";
import { nodeFs } from "@forge/tool-host/src/node-fs";
import { FileCheckpointStore } from "@forge/checkpoints";
import { nodeCheckpointFs } from "@forge/checkpoints/src/node";
import { PendingChanges, type ReviewMode } from "@forge/review";
import { HookRunner, createVerifyTools, detectWeakening, loadCommands, parseHooksConfig, runChecks, type VerificationReport } from "@forge/verify";
import { nodeExec } from "@forge/verify/src/node-exec";
import { createPermissionGate } from "@forge/safety";
import { Runtime } from "../src";

let root: string;
const SUM_BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const TEST_FILE = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "./sum.js";',
  'test("adds small numbers", () => {',
  "  assert.equal(add(1, 2), 3);",
  "  assert.equal(add(2, 3), 5);",
  "});",
  "",
].join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-verify-")).replace(/\\/g, "/");
  writeFileSync(`${root}/package.json`, '{"type":"module","scripts":{"test":"node --test"}}');
  writeFileSync(`${root}/sum.js`, SUM_BUGGY);
  writeFileSync(`${root}/sum.test.js`, TEST_FILE);
  writeFileSync(`${root}/AGENTS.md`, "# Rules\n\n## Commands\n- test: node --test\n- test:file: node --test {file}\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const done: StreamEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });
const text = (t: string): StreamEvent => ({ type: "text", delta: t });

async function build(turns: StreamEvent[][], opts: { mode?: ReviewMode; maxAttempts?: number; hooks?: HookRunner; extraTools?: boolean } = {}) {
  const commands = await loadCommands({ read: nodeCheckpointFs.read, list: nodeCheckpointFs.list }, root);
  const checkpoints = new FileCheckpointStore({ fs: nodeCheckpointFs, dir: `${root}/.forge/checkpoints/s` });
  const pending = new PendingChanges({
    fs: nodeCheckpointFs,
    checkpoints,
    mode: () => opts.mode ?? "auto",
    guard: (p, base, proposed) => detectWeakening(p.slice(root.length + 1), base, proposed),
  });
  const sink = {
    read: async (p: string) => (pending.effective(p) !== undefined ? pending.effective(p)! : nodeCheckpointFs.read(p)),
    propose: async (p: string, c: string | null, r: string) => {
      const o = await pending.propose(p, c, r);
      return { status: o.status, added: o.stats.added, removed: o.stats.removed, checkpoint: o.checkpoint, created: o.created, warnings: o.warnings };
    },
  };
  const verifyOpts = { commands, exec: nodeExec, cwd: root, relatedTests: async (fs: string[]) => (fs.some((f) => f.endsWith("sum.js")) ? ["sum.test.js"] : []) };
  const asked: string[] = [];
  const tools = createToolHost({
    root,
    fs: nodeFs,
    tools: [...READ_TOOLS, ...createEditTools(sink), ...createVerifyTools({ runner: (phase, touched) => runChecks({ ...verifyOpts, phase, touched }), touched: () => [] })],
  });
  const gateway = new ScriptedGateway(turns);
  const runtime = new Runtime({
    gateway,
    tools,
    provider: "p",
    model: "m",
    hooks: opts.hooks,
    gate: createPermissionGate({ ask: async (r) => (asked.push(r.summary), "once"), load: async () => ({ allow: [] }), save: async () => {} }),
    verify: { enabled: () => true, maxAttempts: opts.maxAttempts ?? 5, root, run: (touched, phase, attempt) => runChecks({ ...verifyOpts, phase, touched, attempt }) },
  });
  return { runtime, gateway, pending, checkpoints, asked };
}

async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const reports = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: "verify" }> => e.type === "verify").map((e) => e.report as VerificationReport);

describe("verify-fix loop (exit scenario)", () => {
  it("fixes a seeded failing test, retries after a wrong fix, never weakens the test, and ends Verified", async () => {
    const { runtime, gateway, pending } = await build([
      [call("1", "read_file", { path: "sum.js" }), done],
      // wrong fix: multiplication. 1*2 = 2, expected 3.
      [call("2", "edit_file", { path: "sum.js", old_string: "a - b", new_string: "a * b", reason: "try multiplication" }), done],
      // tempting shortcut: delete the failing assertion. Must be flagged and NOT applied.
      [call("3", "edit_file", { path: "sum.test.js", old_string: "  assert.equal(add(1, 2), 3);\n", new_string: "", reason: "drop failing assertion" }), done],
      // the real fix
      [call("4", "edit_file", { path: "sum.js", old_string: "a * b", new_string: "a + b", reason: "add should add" }), done],
      [text("Fixed: add now adds."), done],
    ]);
    const events = await drain(runtime.run({ mode: "agent", prompt: "make the tests pass" }));

    expect(readFileSync(`${root}/sum.js`, "utf8")).toBe("export function add(a, b) {\n  return a + b;\n}\n");
    expect(readFileSync(`${root}/sum.test.js`, "utf8")).toBe(TEST_FILE); // untouched

    const rs = reports(events);
    expect(rs.map((r) => [r.phase, r.checks.every((c) => c.ok || c.skipped)])).toEqual([
      ["fast", false], // after the wrong fix
      ["fast", true], // after the real fix
      ["full", true],
    ]);
    expect(rs.at(-1)!.verified).toBe(true);
    expect(rs.at(-1)!.summary).toContain("Verified");

    // The failure reached the model as structured errors with the forbid-weakening instruction.
    const feedback = gateway.requests[2]!.messages.filter((m) => m.role === "user").at(-1)!.content;
    expect(feedback).toContain("attempt 1 of 5");
    expect(feedback).toMatch(/sum\.test\.js.*adds small numbers/);
    expect(feedback).toContain("Do NOT delete, skip or weaken tests");

    // The weakening edit was flagged and left pending for the developer; the model was told why.
    const flagged = pending.get(`${root}/sum.test.js`)!;
    expect(flagged.warnings.join()).toContain("removes 1 assertion");
    const toolMsg = gateway.requests[3]!.messages.filter((m) => m.role === "tool").at(-1)!.content;
    expect(toolMsg).toContain("FLAGGED");
  });

  it("stops after the attempt limit and asks the model for a report instead of looping forever", async () => {
    const wrong = (id: string, from: string, to: string): StreamEvent[] => [call(id, "edit_file", { path: "sum.js", old_string: from, new_string: to }), done];
    const { runtime, gateway } = await build(
      [wrong("1", "a - b", "a * b"), wrong("2", "a * b", "a / b"), wrong("3", "a / b", "a % b"), [text("I tried *, / and %. Remaining: add(1,2) is wrong. Hypothesis: the operator."), done]],
      { maxAttempts: 3 },
    );
    const events = await drain(runtime.run({ mode: "agent", prompt: "fix" }));
    expect(events.at(-1)).toEqual({ type: "limit", reason: "verify" });
    expect(reports(events).filter((r) => r.phase === "fast")).toHaveLength(3);
    // The last model turn had no tools and was asked for what it tried, the error, and a hypothesis.
    const last = gateway.requests.at(-1)!;
    expect(last.tools).toEqual([]);
    expect(last.messages.at(-1)!.content).toContain("best hypothesis");
    expect(readFileSync(`${root}/sum.test.js`, "utf8")).toBe(TEST_FILE);
  });

  it("in review mode nothing is verified until accepted, and the run says so", async () => {
    const { runtime, pending } = await build([[call("1", "edit_file", { path: "sum.js", old_string: "a - b", new_string: "a + b" }), done], [text("done"), done]], { mode: "review" });
    const events = await drain(runtime.run({ mode: "agent", prompt: "fix" }));
    expect(readFileSync(`${root}/sum.js`, "utf8")).toBe(SUM_BUGGY);
    expect(reports(events)).toHaveLength(1);
    expect(reports(events)[0]).toMatchObject({ verified: false, summary: expect.stringContaining("pending your review") });
    expect(pending.list()).toHaveLength(1);
  });
});

describe("run_checks tool and permission gate", () => {
  it("is execute-class: hidden in ask mode, listed in agent mode, and the gate is consulted", async () => {
    const { runtime, gateway, asked } = await build([[call("1", "run_checks", { scope: "full" }), done], [text("ok"), done]]);
    const events = await drain(runtime.run({ mode: "agent", prompt: "check" }));
    expect(asked).toEqual([expect.stringContaining("run_checks")]);
    const out = (events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>).result.output;
    expect(out).toContain("FAILED"); // seeded bug still present
    expect(out).toContain("adds small numbers");
    expect(gateway.requests[0]!.tools!.map((t) => t.name)).toContain("run_checks");
    const ask = await build([[done]]);
    await drain(ask.runtime.run({ mode: "ask", prompt: "x" }));
    expect(ask.gateway.requests[0]!.tools!.map((t) => t.name)).not.toContain("run_checks");
  });
});

describe("hooks in the loop", () => {
  const hooksFor = (cfg: object, exec = nodeExec) => new HookRunner({ cwd: root, exec, config: parseHooksConfig(JSON.stringify(cfg)).config });

  it("a PreToolUse hook exiting 2 blocks the tool call and the model sees why", async () => {
    const hooks = hooksFor({ PreToolUse: [{ command: 'node -e "console.log(\'no reading sum.js today\'); process.exit(2)"', matcher: "read_file" }] });
    const { runtime, gateway } = await build([[call("1", "read_file", { path: "sum.js" }), done], [done]], { hooks });
    const events = await drain(runtime.run({ mode: "agent", prompt: "x" }));
    const r = (events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>).result;
    expect(r.ok).toBe(false);
    expect(r.output).toContain("blocked by a PreToolUse hook");
    expect(r.output).toContain("no reading sum.js today");
    expect(gateway.requests).toHaveLength(2);
  });

  it("PostToolUse output is appended to the tool result; Stop can block finishing once", async () => {
    const hooks = hooksFor({ PostToolUse: [{ command: 'node -e "console.log(\'lint reminder\')"' }], Stop: [{ command: 'node -e "console.log(\'update the changelog\'); process.exit(2)"' }] });
    const { runtime, gateway } = await build([[call("1", "read_file", { path: "sum.js" }), done], [text("done"), done], [text("changelog updated"), done]], { hooks });
    const events = await drain(runtime.run({ mode: "agent", prompt: "x" }));
    const r = (events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>).result;
    expect(r.output).toContain("[PostToolUse hook]\nlint reminder");
    expect(events.filter((e) => e.type === "hook" && e.event === "Stop")).toHaveLength(1);
    expect(gateway.requests.at(-1)!.messages.at(-1)!.content).toContain("update the changelog");
    expect(gateway.requests).toHaveLength(3);
  });
});
