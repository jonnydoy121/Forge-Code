import type { AgentEvent } from "@forge/protocol";
import type { RegisteredTool } from "@forge/tool-host";

/** Anything that can run a prompt and stream events (a fresh Runtime in practice). */
export interface SubRunner {
  run(req: { mode: "ask"; prompt: string; signal?: AbortSignal }): AsyncIterable<AgentEvent>;
  costUsd: number;
}

/** A named specialist the coordinator may hand a task to (its definition lives in .forge/agents). */
export interface Specialist {
  name: string;
  description: string;
}

export interface SubAgentDeps {
  /** Build a NEW runtime with its own empty history and read-only tools (no `delegate`, so no recursion). `agent` names a specialist: its own instructions, tools and model tier. */
  make(agent?: string): SubRunner;
  /** The specialists that exist. Without any, `delegate` hands the task to a general sub-agent, as before. */
  specialists?: Specialist[];
  /** Report cost so the parent's cap accounts for it. */
  onCost?(usd: number): void;
  /** Max characters returned to the parent. */
  maxChars?: number;
}

/**
 * `delegate`: heavy exploration ("find every caller of X across services") runs in a sub-agent with a fresh context.
 * Only its final report comes back, so the main thread's context stays clean.
 */
export function createSubAgentTool(deps: SubAgentDeps): RegisteredTool {
  const specialists = deps.specialists ?? [];
  const NL = String.fromCharCode(10);
  return {
    spec: {
      name: "delegate",
      description:
        "Hand a read-only research task to a sub-agent with its own fresh context, e.g. 'find every caller of X and summarise how each uses it'. It can search and read but not edit. You get back only its written report, so be specific about what the report must contain." + (specialists.length ? ` Optionally name a specialist in "agent" (it has its own instructions and tools, and reports back the same way):${NL}${specialists.map((x) => `- ${x.name}: ${x.description}`).join(NL)}` : ""),
      parameters: { type: "object", properties: { task: { type: "string" }, ...(specialists.length ? { agent: { type: "string", enum: specialists.map((x) => x.name) } } : {}) }, required: ["task"] },
      class: "read",
    },
    async run(args) {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) throw new Error("missing required argument: task");
      const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : undefined;
      if (agent && !specialists.some((x) => x.name === agent)) throw new Error(`no specialist named ${JSON.stringify(agent)}. Available: ${specialists.map((x) => x.name).join(", ") || "(none)"}`);
      const sub = deps.make(agent);
      let report = "";
      let limit = "";
      for await (const ev of sub.run({ mode: "ask", prompt: `${task}\n\nWhen you are done, write a concise report of your findings (file paths and line numbers where relevant). This report is all the requester will see.` })) {
        if (ev.type === "text") report += ev.delta;
        else if (ev.type === "tool_call") report = ""; // text before a tool call is working notes, not the report
        else if (ev.type === "limit") limit = ev.reason;
      }
      deps.onCost?.(sub.costUsd);
      const max = deps.maxChars ?? 4000;
      const text = report.trim() || "(the sub-agent produced no report)";
      return `${agent ? `Specialist "${agent}" report` : "Sub-agent report"}${limit ? ` (stopped early: ${limit} limit)` : ""}:\n${text.length > max ? text.slice(0, max) + "\n[truncated]" : text}`;
    },
  };
}
