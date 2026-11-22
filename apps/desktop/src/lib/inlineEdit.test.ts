import { describe, expect, it } from "vitest";
import { buildInlinePrompt, extractReplacement, spliceSelection } from "./inlineEdit";

const ctx = { path: "src/a.ts", language: "typescript", text: "const a = 1;\nconst b = 2;\nconst c = 3;\n", start: 13, end: 25 };

describe("inline edit", () => {
  it("marks the selection and asks for replacement code only", () => {
    const p = buildInlinePrompt(ctx, "rename b to total");
    expect(p).toContain("<<SELECTION>>const b = 2;<</SELECTION>>");
    expect(p).toContain("Instruction: rename b to total");
    expect(p).toContain("ONLY the replacement code");
    expect(p).toContain("const a = 1;"); // surrounding context is included
  });

  it("marks an insertion point when nothing is selected", () => {
    const p = buildInlinePrompt({ ...ctx, start: 13, end: 13 }, "add a log line");
    expect(p).toContain("<<CURSOR>>");
    expect(p).toContain("Insert new code");
  });

  it("limits context so large files do not blow the prompt", () => {
    const big = "x".repeat(50_000) + "TARGET" + "y".repeat(50_000);
    const p = buildInlinePrompt({ ...ctx, text: big, start: 50_000, end: 50_006 }, "i");
    expect(p.length).toBeLessThan(4_000);
  });

  it("unwraps a fenced reply and leaves plain replies alone", () => {
    expect(extractReplacement("```ts\nconst total = 2;\n```")).toBe("const total = 2;");
    expect(extractReplacement("\nconst total = 2;\n")).toBe("const total = 2;");
    expect(extractReplacement("use `x` here, then ```code``` too")).toBe("use `x` here, then ```code``` too");
  });

  it("splices the replacement into the file", () => {
    expect(spliceSelection(ctx.text, ctx.start, ctx.end, "const total = 2;")).toBe("const a = 1;\nconst total = 2;\nconst c = 3;\n");
    expect(spliceSelection("ab", 1, 1, "X")).toBe("aXb");
  });
});
