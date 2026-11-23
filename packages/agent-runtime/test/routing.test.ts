import { describe, expect, it } from "vitest";
import { classifyPrompt, parseComplexity, pickTier, scoutOrBuilder, type RoutingConfig } from "../src";

const builder = { provider: "default", model: "builder-model" };
const cfg: RoutingConfig = { scout: { provider: "scout", model: "scout-model" }, architect: { provider: "architect", model: "architect-model" } };
const pick = (c: RoutingConfig | undefined, mode: "ask" | "plan" | "agent" | "debug", failedChecks = 0, complexity?: "trivial" | "standard" | "complex") => pickTier(c, builder, { mode, failedChecks, complexity });

describe("pickTier", () => {
  it("is always the builder when routing is not configured", () => {
    for (const mode of ["ask", "plan", "agent", "debug"] as const) expect(pick(undefined, mode, 9, "complex").route).toEqual(builder);
    expect(pick({}, "agent").tier).toBe("builder");
  });

  it("gives the builder the first fix attempt and the architect the second", () => {
    expect(pick(cfg, "agent", 0).tier).toBe("builder");
    expect(pick(cfg, "agent", 1).tier).toBe("builder");
    const c = pick(cfg, "agent", 2);
    expect(c.tier).toBe("architect");
    expect(c.route).toEqual(cfg.architect);
    expect(c.reason).toContain("2 times");
  });

  it("escalates after a different number of failures when asked", () => {
    expect(pick({ ...cfg, escalateAfter: 1 }, "agent", 1).tier).toBe("architect");
    expect(pick({ ...cfg, escalateAfter: 3 }, "agent", 2).tier).toBe("builder");
  });

  it("keeps the builder, and says why, when there is no architect to escalate to", () => {
    const c = pick({ scout: cfg.scout }, "agent", 3);
    expect(c.tier).toBe("builder");
    expect(c.reason).toContain("no architect model is set");
  });

  it("uses the architect for plan mode unless told not to, and never the scout for it", () => {
    expect(pick(cfg, "plan").tier).toBe("architect");
    expect(pick({ ...cfg, planWithArchitect: false }, "plan").tier).toBe("builder");
    expect(pick(cfg, "plan", 0, "trivial").tier).toBe("architect");
    expect(pick({ scout: cfg.scout }, "plan", 0, "trivial").tier).toBe("builder");
  });

  it("sends trivial requests to the scout and complex ones to the architect, only when those are set", () => {
    expect(pick(cfg, "ask", 0, "trivial")).toMatchObject({ tier: "scout", route: cfg.scout });
    expect(pick(cfg, "agent", 0, "complex")).toMatchObject({ tier: "architect", route: cfg.architect });
    expect(pick(cfg, "agent", 0, "standard").tier).toBe("builder");
    expect(pick({ architect: cfg.architect }, "ask", 0, "trivial").tier).toBe("builder");
    expect(pick({ scout: cfg.scout }, "agent", 0, "complex").tier).toBe("builder");
  });

  it("counts steps where an external tool errored like failed checks: the builder gets one, the architect the second", () => {
    const withErrors = (failedChecks: number, toolErrors: number) => pickTier(cfg, builder, { mode: "agent", failedChecks, toolErrors });
    expect(withErrors(0, 1).tier).toBe("builder");
    const two = withErrors(0, 2);
    expect(two.tier).toBe("architect");
    expect(two.reason).toBe("tool calls failed 2 times with the default model, so the architect model takes over");
    expect(withErrors(1, 1).reason).toContain("checks and tool calls failed 2 times");
    expect(withErrors(2, 0).reason).toContain("checks failed 2 times"); // the wording for plain check failures is unchanged
    expect(pickTier({ scout: cfg.scout }, builder, { mode: "agent", failedChecks: 0, toolErrors: 3 }).reason).toContain("no architect model is set");
  });

  it("gives the scout one attempt on tool errors too", () => {
    const on = { ...cfg, scoutEdits: true };
    expect(pickTier(on, builder, { mode: "agent", failedChecks: 0, toolErrors: 0, complexity: "trivial" }).tier).toBe("scout");
    expect(pickTier(on, builder, { mode: "agent", failedChecks: 0, toolErrors: 1, complexity: "trivial" }).tier).toBe("builder");
  });

  it("lets the scout take simple edits only when that is switched on, and questions always", () => {
    expect(pick(cfg, "agent", 0, "trivial").tier).toBe("builder");
    expect(pick(cfg, "debug", 0, "trivial").tier).toBe("builder");
    expect(pick({ ...cfg, scoutEdits: true }, "agent", 0, "trivial").tier).toBe("scout");
    expect(pick({ ...cfg, scoutEdits: true }, "debug", 0, "trivial").tier).toBe("scout");
    expect(pick(cfg, "ask", 0, "trivial").tier).toBe("scout");
  });

  it("gives the scout a single attempt: after one failed check the builder takes over, and the architect after two", () => {
    const on = { ...cfg, scoutEdits: true };
    expect(pick(on, "agent", 0, "trivial").tier).toBe("scout");
    expect(pick(on, "agent", 1, "trivial").tier).toBe("builder");
    expect(pick(on, "agent", 2, "trivial").tier).toBe("architect");
  });

  it("never uses a tier that is disabled (local-only mode blocks the remote ones) and falls back to the builder", () => {
    const off: RoutingConfig = { ...cfg, disabled: ["architect"] };
    expect(pick(off, "plan").tier).toBe("builder");
    const c = pick(off, "agent", 2);
    expect(c.tier).toBe("builder");
    expect(c.reason).toContain("no architect model is allowed");
    expect(pick({ ...cfg, disabled: ["scout"] }, "ask", 0, "trivial").tier).toBe("builder");
  });

  it("scoutOrBuilder picks the scout for chores only when it is set and allowed", () => {
    expect(scoutOrBuilder(cfg, builder)).toEqual(cfg.scout);
    expect(scoutOrBuilder({ ...cfg, disabled: ["scout"] }, builder)).toEqual(builder);
    expect(scoutOrBuilder({ architect: cfg.architect }, builder)).toEqual(builder);
    expect(scoutOrBuilder(undefined, builder)).toEqual(builder);
  });
});

describe("classifyPrompt (the free first guess)", () => {
  const c = (p: string, mode: "ask" | "agent" | "plan" | "debug" = "agent") => classifyPrompt(p, mode).complexity;

  it("calls short questions in ask mode trivial", () => {
    expect(c("What does the retry helper do?", "ask")).toBe("trivial");
    expect(c("where is the config loaded", "ask")).toBe("trivial");
    expect(c("Explain src/auth.ts", "ask")).toBe("trivial");
  });

  it("calls small, well-defined edits trivial", () => {
    expect(c("rename the variable x to count in utils.ts")).toBe("trivial");
    expect(c("fix typo in the README heading")).toBe("trivial");
    expect(c("change the button color to blue")).toBe("trivial");
  });

  it("does not call a question trivial in agent mode, or a big edit trivial because it starts like a small one", () => {
    expect(c("What does the retry helper do?", "agent")).toBe("standard");
    expect(c("rename the User type everywhere and update every caller across the codebase")).toBe("standard");
  });

  it("calls a long design or debugging request across several files complex, but needs two signals", () => {
    expect(c("Redesign the architecture of the sync engine: src/sync/a.ts, src/sync/b.ts and src/sync/c.ts share a race condition, find the root cause and migrate them to a single queue.")).toBe("complex");
    expect(c("What is the architecture of this repo?", "ask")).toBe("standard"); // one signal is not enough
    expect(c("Add a retry to the fetch call in src/api.ts")).toBe("standard");
  });

  it("calls ordinary work standard, including empty input", () => {
    expect(c("Add a --verbose flag to the CLI and print each step")).toBe("standard");
    expect(c("")).toBe("standard");
  });
});

describe("parseComplexity", () => {
  it("accepts a one-word answer however it is dressed up", () => {
    expect(parseComplexity("trivial")).toBe("trivial");
    expect(parseComplexity("  Complex.\n")).toBe("complex");
    expect(parseComplexity("STANDARD")).toBe("standard");
  });
  it("treats anything else as no answer", () => {
    for (const bad of ["", "I think this is hard", "easy", "12", "..."]) expect(parseComplexity(bad), bad).toBeNull();
  });
});
