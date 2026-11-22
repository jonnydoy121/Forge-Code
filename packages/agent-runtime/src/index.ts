import type { AgentRuntime } from "@forge/protocol";

export class StubAgentRuntime implements AgentRuntime {
  run: AgentRuntime["run"] = async function* () {
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  };
}
