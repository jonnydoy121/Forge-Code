import type { RegisteredTool } from "@forge/tool-host";
import { parsePlan, validatePlan } from "./plan";
import type { PlanStore } from "./store";

export interface Question { question: string; default?: string }

export interface PlanToolDeps {
  store: PlanStore;
  /** Show the questions (with suggested default answers) to the developer and return their answers. */
  askUser(questions: Question[]): Promise<string[]>;
  /** Called after a plan is written so the UI can open it. */
  onPlanWritten?(slug: string): void;
  /** At most this many questions per session. */
  maxQuestions?: number;
}

/** Tools for Plan mode: write the plan file (the only write allowed there) and ask a few clarifying questions. */
export function createPlanTools(deps: PlanToolDeps): RegisteredTool[] {
  let asked = 0;
  const max = deps.maxQuestions ?? 3;
  return [
    {
      spec: {
        name: "write_plan",
        description:
          "Write or replace the plan file in .forge/plans/. Use the required structure: front matter (title, status: draft), Goal, Assumptions, Files to change, Files to create, Tasks (numbered `N. [ ] **Title** — acceptance: check` with `- files:` lines), Risks, Out of scope. This is the only file you can write in Plan mode.",
        parameters: { type: "object", properties: { markdown: { type: "string" }, slug: { type: "string" } }, required: ["markdown"] },
        class: "plan",
      },
      async run(args) {
        const md = args.markdown;
        if (typeof md !== "string" || !md.trim()) throw new Error("missing required argument: markdown");
        const plan = parsePlan(md);
        const errors = validatePlan(plan).filter((p) => p.severity === "error");
        if (errors.length) throw new Error(`The plan is not valid yet:\n${errors.map((e) => `- ${e.message}`).join("\n")}\nFix these and call write_plan again.`);
        const slug = await deps.store.write(md, typeof args.slug === "string" && args.slug ? args.slug : undefined);
        deps.onPlanWritten?.(slug);
        const warnings = validatePlan(plan).filter((p) => p.severity === "warning");
        return `Plan saved to .forge/plans/${slug}.md with ${plan.steps.length} step(s). The developer will review and edit it before anything is built.${warnings.length ? `\nNotes: ${warnings.map((w) => w.message).join(" ")}` : ""}`;
      },
    },
    {
      spec: {
        name: "ask_user",
        description: `Ask the developer up to ${max} targeted clarifying questions in total, each with a suggested default answer. Only ask when the request is genuinely ambiguous.`,
        parameters: {
          type: "object",
          properties: { questions: { type: "array", items: { type: "object", properties: { question: { type: "string" }, default: { type: "string" } }, required: ["question"] } } },
          required: ["questions"],
        },
        class: "read",
      },
      async run(args) {
        const qs = Array.isArray(args.questions) ? (args.questions as unknown[]).flatMap((q) => (typeof q === "object" && q && typeof (q as Question).question === "string" ? [q as Question] : [])) : [];
        if (qs.length === 0) throw new Error("questions must be a non-empty array of {question, default?}");
        const room = max - asked;
        if (room <= 0) return `You have used all ${max} questions. Proceed with sensible defaults and record them under Assumptions.`;
        const batch = qs.slice(0, room);
        asked += batch.length;
        const answers = await deps.askUser(batch);
        const note = qs.length > room ? `\n(Only ${room} of your ${qs.length} questions were asked; assume defaults for the rest.)` : "";
        return batch.map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? q.default ?? "(no answer)"}`).join("\n\n") + note;
      },
    },
  ];
}
