import type { AgentEvent } from "@forge/protocol";
import type { RegisteredTool } from "@forge/tool-host";

/** Anything that can run a prompt and stream events (a fresh Runtime in practice). */
export interface SubRunner {
  run(req: { mode: "ask"; prompt: string; signal?: AbortSignal }): AsyncIterable<AgentEvent>;
  costUsd: number;
}

export interface SubAgentDeps {
  /** Build a NEW runtime with its own empty history and read-only tools (no `delegate`, so no recursion). */
  make(): SubRunner;
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
  return {
    spec: {
      name: "delegate",
      description:
        "Hand a read-only research task to a sub-agent with its own fresh context, e.g. 'find every caller of X and summarise how each uses it'. It can search and read but not edit. You get back only its written report, so be specific about what the report must contain.",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      class: "read",
    },
    async run(args) {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) throw new Error("missing required argument: task");
      const sub = deps.make();
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
      return `Sub-agent report${limit ? ` (stopped early: ${limit} limit)` : ""}:\n${text.length > max ? text.slice(0, max) + "\n[truncated]" : text}`;
    },
  };
}
