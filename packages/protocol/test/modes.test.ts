import { describe, expect, it } from "vitest";
import { MODE_TOOL_CLASSES } from "../src/modes";

describe("mode tool classes", () => {
  it("never exposes write or execute in ask/plan", () => {
    for (const m of ["ask", "plan"] as const) {
      expect(MODE_TOOL_CLASSES[m]).not.toContain("write");
      expect(MODE_TOOL_CLASSES[m]).not.toContain("execute");
    }
  });
});
