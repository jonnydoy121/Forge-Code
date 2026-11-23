import { describe, expect, it } from "vitest";
import { startersFor } from "./starters";

describe("startersFor", () => {
  it("says what each mode does, and warns that agent mode waits for review", () => {
    expect(startersFor("ask").intro).toContain("only reads");
    expect(startersFor("plan").intro).toContain("approve");
    expect(startersFor("agent").intro).toContain("review");
    expect(startersFor("debug").intro).toContain("cause");
  });

  it("offers prompts about the open file by name, from any folder separator", () => {
    expect(startersFor("ask", "src/app.ts").prompts).toContain("Explain app.ts");
    expect(startersFor("agent", "C:\\proj\\src\\util.ts").prompts).toContain("Add tests for util.ts");
  });

  it("still offers prompts with no file open, and treats an unknown mode as ask", () => {
    for (const mode of ["ask", "plan", "agent", "debug"]) expect(startersFor(mode).prompts.length).toBeGreaterThan(1);
    expect(startersFor("agent").prompts.every((p) => !p.includes("undefined") && !p.includes("null"))).toBe(true);
    expect(startersFor("something-else").intro).toBe(startersFor("ask").intro);
  });
});
