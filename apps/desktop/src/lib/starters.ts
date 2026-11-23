// What the empty chat says, and a few prompts to start from, per mode. Clicking one fills the box (it does not send), so it can be edited.
// Other assistants offer the same: an empty panel with no suggestion leaves people unsure what to type.

export type StarterMode = "ask" | "plan" | "agent" | "debug";

export interface Starters {
  /** one sentence on what this mode does (and, for the ones that change things, that the developer reviews it) */
  intro: string;
  prompts: string[];
}

/** `file` is the open file's name, when there is one, so the prompts can be about it. */
export function startersFor(mode: StarterMode | string, file?: string | null): Starters {
  const f = file ? file.split(/[\\/]/).pop()! : null;
  switch (mode) {
    case "plan":
      return {
        intro: "Plan mode writes a plan for you to approve before anything is changed.",
        prompts: [f ? `Plan how to add tests for ${f}` : "Plan how to add tests for the least-tested module", "Plan a refactor that removes duplicated code", "Plan how to make this project easier to onboard to"],
      };
    case "agent":
      return {
        intro: "Agent mode edits files and runs checks. Every change waits for your review.",
        prompts: [f ? `Add tests for ${f}` : "Add tests for the least-tested module", f ? `Look for bugs in ${f} and fix them` : "Fix the failing checks", "Add error handling where a failure is silently ignored"],
      };
    case "debug":
      return {
        intro: "Debug mode looks for the cause of a failure.",
        prompts: ["Run the checks and explain the first failure", f ? `Why might ${f} fail on unexpected input?` : "Find the likeliest cause of the last error"],
      };
    default:
      return {
        intro: "Ask about this codebase. Ask mode only reads: it never changes anything.",
        prompts: ["What does this project do, and how is it laid out?", f ? `Explain ${f}` : "Where does execution start?", "What are the riskiest parts of this code?"],
      };
  }
}
