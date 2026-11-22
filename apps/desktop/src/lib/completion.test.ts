import { describe, expect, it } from "vitest";
import { buildCompletionPrompt, cleanCompletion, shouldComplete } from "./completion";

const ctx = { path: "src/a.ts", language: "typescript", prefix: "function add(a: number, b: number) {\n  return ", suffix: ";\n}\n" };

describe("completion prompt", () => {
  it("marks the cursor and asks for insertion text only", () => {
    const p = buildCompletionPrompt(ctx);
    expect(p).toContain("return <<CURSOR>>;");
    expect(p).toContain("ONLY the text to insert");
    expect(p).toContain("src/a.ts");
  });
  it("limits context so a huge file does not make a huge request", () => {
    const p = buildCompletionPrompt({ ...ctx, prefix: "x".repeat(50_000), suffix: "y".repeat(50_000) });
    expect(p.length).toBeLessThan(3_500);
  });
});

describe("cleaning a reply", () => {
  it("returns plain code unchanged", () => {
    expect(cleanCompletion("a + b", ctx)).toBe("a + b");
  });
  it("unwraps a fence and drops leading blank lines", () => {
    expect(cleanCompletion("```ts\na + b\n```", ctx)).toBe("a + b");
    expect(cleanCompletion("\n\na + b", ctx)).toBe("a + b");
  });
  it("removes the part of the line that was already typed", () => {
    const c = { prefix: "const total = ", suffix: "" };
    expect(cleanCompletion("const total = 1 + 2;", c)).toBe("1 + 2;");
  });
  it("removes code that already follows the cursor", () => {
    expect(cleanCompletion("a + b;", { prefix: "return ", suffix: ";\n}" })).toBe("a + b");
  });
  it("caps length and lines", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(cleanCompletion(long, ctx).split("\n")).toHaveLength(12);
    expect(cleanCompletion("x".repeat(5000), ctx).length).toBeLessThanOrEqual(800);
  });
  it("shows nothing for an empty reply, a refusal or chatter", () => {
    expect(cleanCompletion("   \n  ", ctx)).toBe("");
    expect(cleanCompletion("I can't help with that", ctx)).toBe("");
    expect(cleanCompletion("Here is the completion: a + b", ctx)).toBe("");
  });
});

describe("when to complete", () => {
  it("skips an empty file and the middle of a word", () => {
    expect(shouldComplete({ prefix: "", suffix: "" })).toBe(false);
    expect(shouldComplete({ prefix: "const tot", suffix: "al = 1" })).toBe(false);
  });
  it("completes at the end of a line, after an operator, and at a word boundary", () => {
    expect(shouldComplete({ prefix: "const total = ", suffix: "" })).toBe(true);
    expect(shouldComplete({ prefix: "const total", suffix: " = 1" })).toBe(true);
    expect(shouldComplete({ prefix: "foo(", suffix: ")" })).toBe(true);
  });
});
