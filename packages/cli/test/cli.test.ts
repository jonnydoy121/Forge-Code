import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedGateway } from "@forge/model-gateway";
import type { StreamEvent } from "@forge/protocol";
import { parseArgs, runCli, type Io } from "../src/cli";
import { unifiedDiff } from "../src/format";

const done: StreamEvent = { type: "done", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.1 } };
const text = (t: string): StreamEvent => ({ type: "text", delta: t });
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });

function project() {
  const dir = mkdtempSync(join(tmpdir(), "forge-cli-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  return dir;
}
function io(cwd: string, gateway: ScriptedGateway | undefined, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { out: (t) => out.push(t), err: (t) => err.push(t), env, cwd, gateway };
  return { i, out: () => out.join(""), err: () => err.join("") };
}
const edit = () => [call("1", "edit_file", { path: "a.js", old_string: "b = 2", new_string: "b = 20", reason: "bump b" }), done];

describe("arguments", () => {
  it("parses commands and options, and takes the key only from the environment", () => {
    const o = parseArgs(["run", "fix", "the", "bug", "--model", "m", "--apply", "--max-steps", "5"], { FORGE_PROVIDER: "openai" });
    expect(o).toMatchObject({ command: "run", prompt: "fix the bug", model: "m", apply: true, maxSteps: 5, provider: "openai" });
    expect(parseArgs(["ask", "x", "--api-key", "sk-secret"], {})).toEqual({ error: "unknown option --api-key" });
  });
  it("rejects bad input with a clear message", () => {
    expect(parseArgs([], {})).toEqual({ error: "missing command (ask or run)" });
    expect(parseArgs(["fly", "x"], {})).toEqual({ error: 'unknown command "fly" (expected ask or run)' });
    expect(parseArgs(["run"], {})).toEqual({ error: '"run" needs a prompt' });
    expect(parseArgs(["ask", "x", "--apply"], {})).toEqual({ error: "--apply only makes sense with run" });
    expect(parseArgs(["run", "x", "--max-cost", "-1"], {})).toEqual({ error: "--max-cost must be a positive number of dollars" });
    expect(parseArgs(["run", "x", "--provider", "bogus"], {})).toEqual({ error: "--provider must be one of ollama, openai, anthropic" });
    expect(parseArgs(["--help"], {})).toEqual({ help: true });
  });
});

describe("forge-code run", () => {
  it("prints the proposed diff and writes nothing by default", async () => {
    const dir = project();
    const t = io(dir, new ScriptedGateway([edit(), [text("Bumped b."), done]]));
    expect(await runCli(["run", "bump b"], t.i)).toBe(0);
    expect(t.out()).toContain("-export const b = 2;");
    expect(t.out()).toContain("+export const b = 20;");
    expect(t.out()).toContain("nothing written");
    expect(readFileSync(`${dir}/a.js`, "utf8")).toContain("b = 2;");
  });

  it("writes the change only with --apply", async () => {
    const dir = project();
    const t = io(dir, new ScriptedGateway([edit(), [text("done"), done]]));
    expect(await runCli(["run", "bump b", "--apply"], t.i)).toBe(0);
    expect(t.out()).toContain("Applied 1 file(s).");
    expect(readFileSync(`${dir}/a.js`, "utf8")).toBe("export const a = 1;\nexport const b = 20;\nexport const c = 3;\n");
  });

  it("emits a machine-readable result with --json", async () => {
    const dir = project();
    const t = io(dir, new ScriptedGateway([edit(), [text("ok"), done]]));
    await runCli(["run", "bump b", "--json"], t.i);
    const r = JSON.parse(t.out());
    expect(r).toMatchObject({ answer: "ok", applied: false, stopped: null });
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: "a.js", added: 1, removed: 1 });
    expect(r.files[0].abs).toBeUndefined();
  });

  it("exits 2 when it stops at a limit", async () => {
    const dir = project();
    const loop = Array.from({ length: 5 }, (_, n) => [call(`r${n}`, "read_file", { path: "a.js" }), done]);
    const t = io(dir, new ScriptedGateway(loop));
    expect(await runCli(["run", "read forever", "--max-steps", "2"], t.i)).toBe(2);
    expect(t.err()).toContain("stopped at the steps limit");
  });
});

describe("forge-code ask", () => {
  it("is read-only: the model is not even offered edit tools", async () => {
    const dir = project();
    const gw = new ScriptedGateway([[text("It exports three constants."), done]]);
    const t = io(dir, gw);
    expect(await runCli(["ask", "what does a.js export?"], t.i)).toBe(0);
    expect(t.out()).toContain("three constants");
    expect(gw.requests[0]!.tools!.map((x) => x.name)).not.toContain("edit_file");
  });

  it("reports a missing model clearly", async () => {
    const t = io(project(), undefined);
    expect(await runCli(["ask", "x"], t.i)).toBe(1);
    expect(t.err()).toContain("no model given");
  });
});

describe("unified diff", () => {
  it("includes context and correct line numbers across several hunks", () => {
    const base = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
    const d = unifiedDiff("f.txt", base, [
      { id: "a", oldStart: 1, oldLines: ["2"], newLines: ["two", "2b"] },
      { id: "b", oldStart: 8, oldLines: ["9"], newLines: ["nine"] },
    ]);
    expect(d).toContain("--- a/f.txt\n+++ b/f.txt");
    expect(d).toContain("@@ -1,4 +1,5 @@");
    expect(d).toContain("@@ -7,4 +8,4 @@"); // old line 7 is new line 8 after the first hunk added one line
  });
  it("marks new files", () => {
    expect(unifiedDiff("n.txt", null, [{ id: "a", oldStart: 0, oldLines: [""], newLines: ["hello", ""] }])).toContain("--- /dev/null");
  });
});
