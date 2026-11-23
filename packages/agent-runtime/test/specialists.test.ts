import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@forge/protocol";
import { createSubAgentTool, type SubRunner } from "../src";

const ctx = { root: "/ws", fs: { readFile: async () => "", readdir: async () => [] } };

/** A sub-agent that "researches" by saying what it was asked to do. */
function runner(label: string, calls: (string | undefined)[], who?: string): SubRunner {
  calls.push(who);
  return {
    costUsd: 0.25,
    async *run(req) {
      yield { type: "text", delta: `[${label}] ${req.prompt.split("\n")[0]}` } as AgentEvent;
    },
  };
}

describe("delegate with specialists", () => {
  const specialists = [
    { name: "security-reviewer", description: "Reviews code for security problems" },
    { name: "doc-writer", description: "Checks that docs match the code" },
  ];

  it("tells the coordinator which specialists exist, and restricts the choice to them", () => {
    const tool = createSubAgentTool({ make: () => runner("x", []), specialists });
    expect(tool.spec.description).toContain("- security-reviewer: Reviews code for security problems");
    expect(tool.spec.description).toContain("- doc-writer: Checks that docs match the code");
    const props = (tool.spec.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.agent!.enum).toEqual(["security-reviewer", "doc-writer"]);
  });

  it("is the plain sub-agent tool when there are no specialists: no agent argument at all", () => {
    const tool = createSubAgentTool({ make: () => runner("x", []) });
    expect(Object.keys((tool.spec.parameters as { properties: object }).properties)).toEqual(["task"]);
    expect(tool.spec.description).not.toContain("specialist");
  });

  it("hands the task to the named specialist and says in the report who wrote it", async () => {
    const made: (string | undefined)[] = [];
    let cost = 0;
    const tool = createSubAgentTool({ make: (a) => runner(a ?? "general", made, a), specialists, onCost: (usd) => (cost += usd) });
    const out = await tool.run({ task: "audit the login handler", agent: "security-reviewer" }, ctx);
    expect(made).toEqual(["security-reviewer"]);
    expect(String(out)).toContain('Specialist "security-reviewer" report');
    expect(String(out)).toContain("[security-reviewer] audit the login handler");
    expect(cost).toBe(0.25); // its spending counts toward the coordinator's limit
  });

  it("uses the general sub-agent when no specialist is named (a blank name counts as none)", async () => {
    const made: (string | undefined)[] = [];
    const tool = createSubAgentTool({ make: (a) => runner(a ?? "general", made, a), specialists });
    const plain = String(await tool.run({ task: "find callers of load()" }, ctx));
    const blank = String(await tool.run({ task: "find callers of load()", agent: "  " }, ctx));
    expect(made).toEqual([undefined, undefined]);
    expect(plain).toContain("Sub-agent report");
    expect(blank).toContain("Sub-agent report");
  });

  it("refuses a specialist that does not exist, naming the ones that do, without starting anything", async () => {
    const made: (string | undefined)[] = [];
    const tool = createSubAgentTool({ make: (a) => runner("x", made, a), specialists });
    await expect(tool.run({ task: "do it", agent: "wizard" }, ctx)).rejects.toThrow('no specialist named "wizard". Available: security-reviewer, doc-writer');
    expect(made).toEqual([]);
  });

  it("still needs a task", async () => {
    const tool = createSubAgentTool({ make: () => runner("x", []), specialists });
    await expect(tool.run({ agent: "doc-writer" }, ctx)).rejects.toThrow("missing required argument: task");
  });
});
