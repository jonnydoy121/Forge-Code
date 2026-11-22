import { describe, expect, it } from "vitest";
import { createToolHost, type FsBackend } from "@forge/tool-host";
import {
  PLAN_TEMPLATE,
  PlanExecutor,
  PlanGuard,
  PlanStore,
  addFileToPlan,
  addStepComment,
  allowedFiles,
  classifyIntent,
  createPlanTools,
  looksLarge,
  parsePlan,
  progress,
  setPlanStatus,
  setStepStatus,
  slugify,
  stepPrompt,
  validatePlan,
  type PlanFs,
} from "../src";

const PLAN = `---
title: Add CSV export
status: draft
---
# Add CSV export

## Goal
Users can download the reports table as CSV.

## Assumptions
- UTF-8, comma separated.

## Files to change
- \`src/reports/page.tsx\` — add the Export button

## Files to create
- \`src/reports/csv.ts\` — CSV serialisation

## Tasks
1. [ ] **Add the serializer** — acceptance: \`npm test -- csv\` passes
   - files: src/reports/csv.ts
2. [~] **Wire up the button**
   - acceptance: clicking Export downloads a file
   - files: src/reports/page.tsx, src/reports/csv.ts
   > use the existing Button component
3. [x] **Docs** — acceptance: README mentions export

## Risks
- Large tables may be slow.

## Out of scope
- XLSX export
`;

describe("parsePlan", () => {
  const p = parsePlan(PLAN, "csv");
  it("reads the metadata and every section", () => {
    expect(p).toMatchObject({ slug: "csv", title: "Add CSV export", status: "draft", goal: "Users can download the reports table as CSV." });
    expect(p.assumptions).toEqual(["UTF-8, comma separated."]);
    expect(p.filesToChange).toEqual([{ path: "src/reports/page.tsx", reason: "add the Export button" }]);
    expect(p.filesToCreate).toEqual([{ path: "src/reports/csv.ts", reason: "CSV serialisation" }]);
    expect(p.risks).toEqual(["Large tables may be slow."]);
    expect(p.outOfScope).toEqual(["XLSX export"]);
  });
  it("reads steps with statuses, acceptance (inline or nested), files and comments", () => {
    expect(p.steps.map((s) => [s.n, s.status, s.title])).toEqual([[1, "pending", "Add the serializer"], [2, "in-progress", "Wire up the button"], [3, "verified", "Docs"]]);
    expect(p.steps[0]).toMatchObject({ acceptance: "`npm test -- csv` passes", files: ["src/reports/csv.ts"] });
    expect(p.steps[1]).toMatchObject({ acceptance: "clicking Export downloads a file", files: ["src/reports/page.tsx", "src/reports/csv.ts"], comments: ["use the existing Button component"] });
    expect(progress(p)).toMatchObject({ done: 1, total: 3, next: { n: 1 } });
  });
  it("is forgiving about hand-edited plans", () => {
    const q = parsePlan("# Quick\n\n## Goal\nx\n\n## Tasks\n1. [ ] do it — acceptance: works\n");
    expect(q.title).toBe("Quick");
    expect(q.steps[0]).toMatchObject({ title: "do it", acceptance: "works" });
    expect(parsePlan("no structure at all").steps).toEqual([]);
  });
  it("the template in the prompt is itself a valid plan skeleton", () => {
    const t = parsePlan(PLAN_TEMPLATE);
    expect(t.steps).toHaveLength(2);
    expect(validatePlan(t).filter((x) => x.severity === "error")).toEqual([]);
  });
});

describe("validatePlan / allowedFiles", () => {
  it("requires a goal, steps and acceptance checks", () => {
    const bad = validatePlan(parsePlan("# x\n\n## Tasks\n1. [ ] a\n"));
    expect(bad.filter((b) => b.severity === "error").map((b) => b.message)).toEqual(["The plan has no Goal section.", "Step 1 (a) has no acceptance check."]);
    expect(validatePlan(parsePlan("# x")).map((b) => b.message)).toEqual(expect.arrayContaining([expect.stringContaining("no tasks")]));
  });
  it("collects every file the plan mentions", () => {
    expect([...allowedFiles(parsePlan(PLAN))].sort()).toEqual(["src/reports/csv.ts", "src/reports/page.tsx"]);
  });
});

describe("in-place edits", () => {
  it("changes only the step marker, preserving everything else", () => {
    const next = setStepStatus(PLAN, 1, "verified");
    expect(next.replace("1. [x]", "1. [ ]")).toBe(PLAN);
    expect(parsePlan(setStepStatus(PLAN, 2, "failed")).steps[1]!.status).toBe("failed");
  });
  it("updates and adds front matter status", () => {
    expect(parsePlan(setPlanStatus(PLAN, "building")).status).toBe("building");
    expect(setPlanStatus("# x", "approved")).toMatch(/^---\nstatus: approved\n---\n# x/);
  });
  it("adds reviewer comments under the right step", () => {
    const p = parsePlan(addStepComment(PLAN, 1, "also handle quotes"));
    expect(p.steps[0]!.comments).toEqual(["also handle quotes"]);
    expect(p.steps[1]!.comments).toEqual(["use the existing Button component"]);
  });
  it("adds a file to Files to change, creating the section if needed", () => {
    expect(parsePlan(addFileToPlan(PLAN, "src/utils/date.ts", "needed")).filesToChange.map((f) => f.path)).toEqual(["src/reports/page.tsx", "src/utils/date.ts"]);
    expect(parsePlan(addFileToPlan("# x\n\n## Goal\ng\n", "a.ts", "r")).filesToChange).toEqual([{ path: "a.ts", reason: "r" }]);
  });
  it("slugifies titles safely", () => {
    expect(slugify("Add CSV export!")).toBe("add-csv-export");
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify("???")).toBe("plan");
  });
});

describe("classifyIntent", () => {
  it("only clear, unqualified instructions mean build", () => {
    for (const t of ["go", "Go ahead", "build it", "ok go", "yes, proceed", "start building", "execute the plan", "do it", "let's go"]) expect(classifyIntent(t), t).toBe("build");
  });
  it("plan-editing requests never execute", () => {
    for (const t of ["update the plan", "change step 2 to use the logger", "add a step for docs", "revise the plan to skip tests", "the plan should include a migration"]) expect(classifyIntent(t), t).toBe("edit-plan");
  });
  it("mixed or vague wording is ambiguous and executes nothing", () => {
    for (const t of ["update the plan and go", "update the plan, then go ahead", "I think we could maybe go ahead at some point", "sounds good"]) expect(classifyIntent(t), t).not.toBe("build");
    expect(classifyIntent("update the plan and go")).toBe("ambiguous");
    expect(classifyIntent("")).toBe("none");
  });
});

describe("looksLarge", () => {
  it("suggests Plan mode for big requests only", () => {
    for (const t of ["Refactor the auth module to use sessions", "Migrate the database layer to Postgres", "Add a feature to export reports as CSV", "Rename getById everywhere across the codebase", "Update a.ts, b.ts and c.ts to use the new logger"]) expect(looksLarge(t), t).toBe(true);
    for (const t of ["fix the typo in README", "what does this function do?", "why is this test failing", "ok"]) expect(looksLarge(t), t).toBe(false);
  });
});

// ---- store, tools, executor, guard ----

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs: PlanFs = {
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    list: async (d) => [...files.keys()].filter((k) => k.startsWith(d + "/")).map((k) => k.slice(d.length + 1)),
  };
  return { files, fs };
}

describe("PlanStore", () => {
  it("writes, lists and updates plans under .forge/plans", async () => {
    const { files, fs } = memFs();
    const store = new PlanStore(fs, "/ws");
    const slug = await store.write(PLAN);
    expect(slug).toBe("add-csv-export");
    expect(files.has("/ws/.forge/plans/add-csv-export.md")).toBe(true);
    await store.setStep(slug, 1, "verified");
    expect((await store.read(slug))!.plan.steps[0]!.status).toBe("verified");
    expect((await store.list()).map((x) => x.slug)).toEqual(["add-csv-export"]);
    await expect(store.setStep("nope", 1, "verified")).rejects.toThrow("no plan");
  });
  it("cannot be tricked into writing outside .forge/plans", async () => {
    const { files, fs } = memFs();
    await new PlanStore(fs, "/ws").write(PLAN, "../../../etc/passwd");
    expect([...files.keys()]).toEqual(["/ws/.forge/plans/etc-passwd.md"]);
  });
});

const nofs: FsBackend = { readFile: async () => "", readdir: async () => [] };

describe("plan tools", () => {
  const setup = (answers: string[] = []) => {
    const { files, fs } = memFs();
    const store = new PlanStore(fs, "/ws");
    const asked: string[][] = [];
    const written: string[] = [];
    const host = createToolHost({ root: "/ws", fs: nofs, tools: createPlanTools({ store, askUser: async (qs) => (asked.push(qs.map((q) => q.question)), answers.length ? answers : qs.map((q) => q.default ?? "")), onPlanWritten: (s) => written.push(s) }) });
    return { files, host, asked, written };
  };

  it("write_plan is available in plan mode (and agent), but not ask mode", () => {
    const { host } = setup();
    expect(host.listTools("plan").map((t) => t.name).sort()).toEqual(["ask_user", "write_plan"]);
    expect(host.listTools("ask").map((t) => t.name)).toEqual(["ask_user"]);
    expect(host.listTools("agent").map((t) => t.name).sort()).toEqual(["ask_user", "write_plan"]);
  });
  it("saves a valid plan and tells the model what happens next", async () => {
    const { host, files, written } = setup();
    const r = await host.call("plan", { id: "1", name: "write_plan", args: { markdown: PLAN } });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("3 step(s)");
    expect(files.has("/ws/.forge/plans/add-csv-export.md")).toBe(true);
    expect(written).toEqual(["add-csv-export"]);
  });
  it("rejects invalid plans with actionable errors and writes nothing", async () => {
    const { host, files } = setup();
    const r = await host.call("plan", { id: "1", name: "write_plan", args: { markdown: "# x\n\n## Tasks\n1. [ ] a\n" } });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no Goal");
    expect(files.size).toBe(0);
  });
  it("ask_user returns answers with defaults and caps the total number of questions", async () => {
    const { host, asked } = setup(["Postgres", "yes"]);
    const q = (n: number) => ({ questions: Array.from({ length: n }, (_, i) => ({ question: `Q${i}`, default: "d" })) });
    const r1 = await host.call("plan", { id: "1", name: "ask_user", args: q(2) });
    expect(r1.output).toBe("Q: Q0\nA: Postgres\n\nQ: Q1\nA: yes");
    const r2 = await host.call("plan", { id: "2", name: "ask_user", args: q(4) });
    expect(asked.flat()).toEqual(["Q0", "Q1", "Q0"]); // only 1 more allowed (max 3)
    expect(r2.output).toContain("Only 1 of your 4 questions were asked");
    const r3 = await host.call("plan", { id: "3", name: "ask_user", args: q(1) });
    expect(r3.output).toContain("used all 3 questions");
  });
});

describe("PlanExecutor", () => {
  async function setup(outcomes: { ok: boolean; reason?: string }[]) {
    const { fs, files } = memFs();
    const store = new PlanStore(fs, "/ws");
    const slug = await store.write(PLAN.replace("2. [~]", "2. [ ]").replace("3. [x]", "3. [ ]"));
    const calls: { n: number; prompt: string }[] = [];
    const tags: [string, number][] = [];
    const progressLog: string[] = [];
    const ctl = new AbortController();
    const ex = new PlanExecutor({
      store,
      beginChangeSet: (l, n) => tags.push([l, n]),
      onProgress: (_s, p) => progressLog.push(p.steps.map((s) => s.status[0]).join("")),
      signal: ctl.signal,
      runStep: async (step, prompt) => (calls.push({ n: step.n, prompt }), outcomes.shift() ?? { ok: true }),
    });
    return { ex, store, slug, calls, tags, progressLog, ctl, files };
  }

  it("runs steps in order, tags each with its number, and records status in the plan file", async () => {
    const t = await setup([{ ok: true }, { ok: true }, { ok: true }]);
    expect(await t.ex.build(t.slug)).toEqual({ status: "done" });
    expect(t.calls.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(t.tags).toEqual([["Add the serializer", 1], ["Wire up the button", 2], ["Docs", 3]]);
    const final = (await t.store.read(t.slug))!.plan;
    expect(final.status).toBe("done");
    expect(final.steps.every((s) => s.status === "verified")).toBe(true);
    expect(t.progressLog).toContain("ipp"); // step 1 in progress while the rest are pending
  });

  it("step prompts are scoped: this step, acceptance, allowed files, reviewer comments", async () => {
    const t = await setup([{ ok: true }, { ok: true }, { ok: true }]);
    await t.store.edit(t.slug, (md) => addStepComment(md, 2, "use the existing Button component"));
    await t.ex.build(t.slug);
    const p2 = t.calls[1]!.prompt;
    expect(p2).toContain("Execute step 2 of 3");
    expect(p2).toContain("Do only this step");
    expect(p2).toContain("Acceptance check: clicking Export downloads a file");
    expect(p2).toContain("use the existing Button component");
    expect(p2).toContain("Already done and verified:\n- 1. Add the serializer");
    expect(p2).toContain("XLSX export");
  });

  it("stops at the first failed step, marks it failed, pauses the plan, and resumes from it", async () => {
    const t = await setup([{ ok: true }, { ok: false, reason: "tests failed" }]);
    expect(await t.ex.build(t.slug)).toEqual({ status: "failed", step: 2, reason: "tests failed" });
    let plan = (await t.store.read(t.slug))!.plan;
    expect([plan.status, ...plan.steps.map((s) => s.status)]).toEqual(["paused", "verified", "failed", "pending"]);
    // "Paused and resumed in a new session": a fresh executor continues from the failed step.
    t.calls.length = 0;
    expect(await t.ex.build(t.slug)).toEqual({ status: "done" });
    expect(t.calls.map((c) => c.n)).toEqual([2, 3]);
    plan = (await t.store.read(t.slug))!.plan;
    expect(plan.status).toBe("done");
  });

  it("pauses cleanly when aborted between steps", async () => {
    const t = await setup([{ ok: true }]);
    t.ctl.abort();
    expect(await t.ex.build(t.slug)).toEqual({ status: "paused", nextStep: 1 });
    expect(t.calls).toEqual([]);
  });
});

describe("PlanGuard (out-of-plan edits)", () => {
  async function setup(answer: boolean) {
    const { fs } = memFs();
    const store = new PlanStore(fs, "/ws");
    const slug = await store.write(PLAN);
    const asked: string[] = [];
    const blocked: string[] = [];
    const guard = new PlanGuard({ store, askAddFile: async (q) => (asked.push(q), answer), onBlocked: (p) => blocked.push(p) }, "/ws");
    return { guard, store, slug, asked, blocked };
  }

  it("does nothing when no plan is being built", async () => {
    const t = await setup(false);
    expect(await t.guard.authorize("/ws/anything.ts")).toBeNull();
  });
  it("allows plan files without asking", async () => {
    const t = await setup(false);
    t.guard.activate(t.slug, 1);
    expect(await t.guard.authorize("/ws/src/reports/csv.ts")).toBeNull();
    expect(t.asked).toEqual([]);
  });
  it("stops and asks for a file outside the plan; approval adds it to the plan file", async () => {
    const t = await setup(true);
    t.guard.activate(t.slug, 3);
    expect(await t.guard.authorize("/ws/utils/date.ts")).toBeNull();
    expect(t.asked).toEqual(["Step 3 also needs utils/date.ts. Add it to the plan?"]);
    expect(t.blocked).toEqual(["utils/date.ts"]);
    expect((await t.store.read(t.slug))!.plan.filesToChange.map((f) => f.path)).toContain("utils/date.ts");
    // second time it is allowed without asking
    expect(await t.guard.authorize("/ws/utils/date.ts")).toBeNull();
    expect(t.asked).toHaveLength(1);
  });
  it("refusal blocks the edit with a message the model can act on, and leaves the plan alone", async () => {
    const t = await setup(false);
    t.guard.activate(t.slug, 2);
    const msg = await t.guard.authorize("/ws/secret/other.ts");
    expect(msg).toContain("not in the approved plan");
    expect(msg).toContain("declined");
    expect((await t.store.read(t.slug))!.plan.filesToChange.map((f) => f.path)).not.toContain("secret/other.ts");
  });
  it("stepPrompt lists the files the plan allows", () => {
    expect(stepPrompt(parsePlan(PLAN), parsePlan(PLAN).steps[0]!)).toContain("src/reports/page.tsx");
  });
});
