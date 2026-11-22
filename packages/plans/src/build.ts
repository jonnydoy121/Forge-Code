import { addFileToPlan, allowedFiles, parsePlan, progress, type Plan, type PlanStep } from "./plan";
import type { PlanStore } from "./store";

export interface StepOutcome {
  /** The step's acceptance checks passed (verified). */
  ok: boolean;
  reason?: string;
}

export interface ExecutorDeps {
  store: PlanStore;
  /** Run the agent on one step and resolve when its turn, including verification, has ended. */
  runStep(step: PlanStep, prompt: string, plan: Plan): Promise<StepOutcome>;
  /** Tag everything the agent changes during this step with the step number. */
  beginChangeSet?(label: string, step: number): void;
  onProgress?(slug: string, plan: Plan): void;
  signal?: AbortSignal;
}

export type BuildResult = { status: "done" } | { status: "failed"; step: number; reason?: string } | { status: "paused"; nextStep?: number };

/** The prompt for one step. Scope is explicit: this step only, plan files only. */
export function stepPrompt(plan: Plan, step: PlanStep): string {
  const done = plan.steps.filter((s) => s.status === "verified").map((s) => `${s.n}. ${s.title}`);
  const allowed = [...allowedFiles(plan)];
  return [
    `Execute step ${step.n} of ${plan.steps.length} of the approved plan "${plan.title}". Do only this step.`,
    `Goal of the plan: ${plan.goal}`,
    done.length ? `Already done and verified:\n${done.map((d) => `- ${d}`).join("\n")}` : "",
    `Step ${step.n}: ${step.title}`,
    `Acceptance check: ${step.acceptance}`,
    step.files.length ? `Files for this step: ${step.files.join(", ")}` : "",
    step.comments.length ? `Reviewer comments on this step:\n${step.comments.map((c) => `- ${c}`).join("\n")}` : "",
    allowed.length ? `Files the plan allows you to change: ${allowed.join(", ")}.` : "",
    "If this step needs a file that is not in the plan, attempt the edit anyway: the developer will be asked to approve adding it. Do not work around the plan by editing other files.",
    plan.outOfScope.length ? `Out of scope (do not do): ${plan.outOfScope.join("; ")}` : "",
    "Use the existing utilities and patterns found via the index; if you introduce a new pattern, say why. When the step is complete, say so briefly.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Executes an approved plan step by step, tracking status in the plan file as it goes. */
export class PlanExecutor {
  constructor(private deps: ExecutorDeps) {}

  async build(slug: string): Promise<BuildResult> {
    const { deps } = this;
    const store = deps.store;
    const first = await store.read(slug);
    if (!first) throw new Error(`no plan named ${slug}`);
    await store.setStatus(slug, "building");
    for (;;) {
      const cur = (await store.read(slug))!.plan;
      deps.onProgress?.(slug, cur);
      const next = progress(cur).next;
      if (!next) {
        await store.setStatus(slug, "done");
        deps.onProgress?.(slug, (await store.read(slug))!.plan);
        return { status: "done" };
      }
      if (deps.signal?.aborted) {
        await store.setStatus(slug, "paused");
        return { status: "paused", nextStep: next.n };
      }
      await store.setStep(slug, next.n, "in-progress");
      deps.beginChangeSet?.(next.title, next.n);
      deps.onProgress?.(slug, (await store.read(slug))!.plan);
      const fresh = (await store.read(slug))!.plan;
      const outcome = await deps.runStep(fresh.steps.find((s) => s.n === next.n)!, stepPrompt(fresh, fresh.steps.find((s) => s.n === next.n)!), fresh);
      if (deps.signal?.aborted && !outcome.ok) {
        await store.setStep(slug, next.n, "pending");
        await store.setStatus(slug, "paused");
        return { status: "paused", nextStep: next.n };
      }
      if (!outcome.ok) {
        await store.setStep(slug, next.n, "failed");
        await store.setStatus(slug, "paused");
        deps.onProgress?.(slug, (await store.read(slug))!.plan);
        return { status: "failed", step: next.n, reason: outcome.reason };
      }
      await store.setStep(slug, next.n, "verified");
    }
  }
}

// ---------- out-of-plan protection ----------

export interface PlanGuardDeps {
  store: PlanStore;
  /** Ask the developer, e.g. "Step 3 also needs utils/date.ts. Add it?". Resolves true to add it to the plan. */
  askAddFile(question: string, path: string, step: number | undefined): Promise<boolean>;
  /** Surface a blocked edit in the UI. */
  onBlocked?(path: string, message: string): void;
}

/**
 * While a plan is being built, edits outside the plan stop and ask. `authorize` is wired into the edit tools:
 * it returns null to allow, or the message the model sees when the developer says no.
 */
export class PlanGuard {
  private active: { slug: string; step?: number } | null = null;
  constructor(private deps: PlanGuardDeps, private root: string) {}

  activate(slug: string, step?: number) {
    this.active = { slug, step };
  }
  setStep(step: number | undefined) {
    if (this.active) this.active.step = step;
  }
  deactivate() {
    this.active = null;
  }
  get isActive() {
    return this.active !== null;
  }

  async authorize(absPath: string): Promise<string | null> {
    if (!this.active) return null;
    const rel = absPath.startsWith(this.root + "/") ? absPath.slice(this.root.length + 1) : absPath;
    const cur = await this.deps.store.read(this.active.slug);
    if (!cur) return null;
    if (allowedFiles(cur.plan).has(rel)) return null;
    const step = this.active.step;
    const q = `${step !== undefined ? `Step ${step}` : "The agent"} also needs ${rel}. Add it to the plan?`;
    this.deps.onBlocked?.(rel, q);
    if (await this.deps.askAddFile(q, rel, step)) {
      await this.deps.store.edit(this.active.slug, (md) => addFileToPlan(md, rel, `needed by step ${step ?? "?"} (added with your approval)`));
      return null;
    }
    return `${rel} is not in the approved plan and the developer declined to add it. Do not edit it. Finish the step using only plan files, or stop and explain what is blocked.`;
  }
}

export { parsePlan };
