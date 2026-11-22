// Skills end to end: a model turn through the real permission gate, running a real script with real Node.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { READ_TOOLS, createToolHost, type FsBackend } from "@forge/tool-host";
import { createSkillTools, loadSkills, type SkillFs } from "@forge/context-store";
import { nodeExec } from "@forge/verify/src/node-exec";
import { AuditLog, createPermissionGate, type AskRequest, type Remember } from "@forge/safety";
import { Runtime } from "../src";

const done: StreamEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
const text = (t: string): StreamEvent => ({ type: "text", delta: t });
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });
async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const nodeFs: SkillFs = {
  read: async (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  list: async (d) => readdirSync(d),
  write: async (p, c) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, c)),
  remove: async (p) => void (existsSync(p) && (await import("node:fs")).rmSync(p)),
};
const toolFs: FsBackend = { readFile: async (p) => readFileSync(p, "utf8"), readdir: async () => [] };

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "forge-skill-")).replace(/[\\]/g, "/");
  const dir = `${root}/.forge/skills/greet`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/SKILL.md`, "---\ndescription: Write a greeting file\n---\n# Greet\nRun greet.js with a name, then report the file it wrote.\n");
  // The script reads its arguments from the JSON file given as argv[2], writes a file, and prints.
  writeFileSync(`${dir}/greet.js`, "const fs = require('fs');\nconst args = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\nfs.writeFileSync('greeting.txt', 'Hello, ' + args.name + '!');\nconsole.log('wrote greeting for ' + args.name);\n");
  return root;
}

function run(root: string, answers: Remember[], steps: StreamEvent[][]) {
  const asked: AskRequest[] = [];
  const audit = new AuditLog(null, "/a");
  const gate = createPermissionGate({ ask: async (r) => (asked.push(r), answers.shift() ?? "deny"), load: async () => ({ allow: [] }), save: async () => {}, audit: (e) => audit.record({ kind: "permission", name: e.tool, detail: `${e.decision}: ${e.summary}` }) });
  const tools = createToolHost({
    root,
    fs: toolFs,
    tools: [...READ_TOOLS, ...createSkillTools({ root, fs: nodeFs, skills: () => loadSkills(nodeFs, `${root}/.forge/skills`), exec: nodeExec, sandbox: () => false, audit: (e) => audit.record({ kind: "command", name: e.name, detail: e.detail, blocked: e.blocked }) })],
  });
  const gw = new ScriptedGateway(steps);
  const rt = new Runtime({ gateway: gw, tools, provider: "p", model: "m", gate });
  return { asked, audit, gw, go: () => drain(rt.run({ mode: "agent", prompt: "greet the world" })) };
}

describe("skills through a real model turn", () => {
  it("loads the skill without a prompt, asks before running its script, and the script receives its arguments", async () => {
    const root = workspace();
    const r = run(root, ["once"], [
      [call("1", "use_skill", { name: "greet" }), done],
      [call("2", "run_skill_script", { skill: "greet", script: "greet.js", args: { name: "World" } }), done],
      [text("I wrote greeting.txt."), done],
    ]);
    const events = await r.go();
    // Loading instructions is a read: no prompt. Running a script is execute: exactly one prompt.
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.tool).toBe("run_skill_script");
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results[0]!.result.output).toContain("# Skill: greet");
    expect(results[0]!.result.output).toContain("Bundled scripts");
    expect(results[1]!.result.output).toContain("exit code 0");
    expect(results[1]!.result.output).toContain("wrote greeting for World");
    // The script really ran, in the workspace root, with the model's arguments.
    expect(readFileSync(`${root}/greeting.txt`, "utf8")).toBe("Hello, World!");
    // The temporary arguments file is gone.
    expect(existsSync(`${root}/.forge/skill-runs`) ? readdirSync(`${root}/.forge/skill-runs`) : []).toEqual([]);
    // And the run is on the audit trail.
    expect(JSON.stringify(r.audit.list())).toContain("skill greet/greet.js");
  });

  it("never runs the script when the developer declines", async () => {
    const root = workspace();
    const r = run(root, ["deny"], [
      [call("1", "run_skill_script", { skill: "greet", script: "greet.js", args: { name: "World" } }), done],
      [text("The developer declined."), done],
    ]);
    const events = await r.go();
    expect(existsSync(`${root}/greeting.txt`)).toBe(false);
    const result = events.find((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")!;
    expect(result.result.ok).toBe(false);
    expect(result.result.output).toContain("denied");
  });

  it("a model that invents a script name or tries a path trick gets an error and nothing runs", async () => {
    const root = workspace();
    writeFileSync(`${root}/secret-runner.js`, "require('fs').writeFileSync('pwned.txt', 'x');");
    const r = run(root, ["once", "once"], [
      [call("1", "run_skill_script", { skill: "greet", script: "../../../secret-runner.js" }), done],
      [call("2", "run_skill_script", { skill: "greet", script: "missing.js" }), done],
      [text("giving up"), done],
    ]);
    const events = await r.go();
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.map((x) => x.result.ok)).toEqual([false, false]);
    expect(results[0]!.result.output).toContain("has no script");
    expect(existsSync(`${root}/pwned.txt`)).toBe(false);
    expect(existsSync(`${root}/greeting.txt`)).toBe(false);
  });
});
