import { describe, expect, it } from "vitest";
import { StubAgentRuntime } from "../src";

describe("AgentRuntime contract", () => {
  it("terminates with a done event", async () => {
    const types: string[] = [];
    for await (const e of new StubAgentRuntime().run({ mode: "ask", prompt: "q" })) types.push(e.type);
    expect(types.at(-1)).toBe("done");
  });
});
