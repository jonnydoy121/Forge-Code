import { describe, expect, it } from "vitest";
import { toolSummary } from "./toolSummary";

describe("toolSummary", () => {
  it("picks the most telling argument", () => {
    expect(toolSummary({ path: "src/app.ts" })).toBe("src/app.ts");
    expect(toolSummary({ pattern: "TODO", glob: "*.ts" })).toBe("TODO");
    expect(toolSummary({ command: "npm test" })).toBe("npm test");
    expect(toolSummary({ reason: "x", path: "a.ts", old_string: "long text" })).toBe("a.ts");
  });

  it("keeps the first line only and shortens a long value", () => {
    expect(toolSummary({ command: "echo one\necho two" })).toBe("echo one…");
    expect(toolSummary({ path: "x".repeat(200) }, 20)).toHaveLength(20);
    expect(toolSummary({ path: "x".repeat(200) }, 20).endsWith("…")).toBe(true);
  });

  it("is empty when there is nothing useful, and never throws on odd input", () => {
    for (const odd of [undefined, null, 3, "text", [], {}, { path: "" }, { path: { nested: true } }]) expect(toolSummary(odd)).toBe("");
  });
});
