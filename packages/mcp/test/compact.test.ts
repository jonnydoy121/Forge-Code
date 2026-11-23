import { describe, expect, it } from "vitest";
import { compactResult, DEFAULT_MAX_CHARS } from "../src/compact";

const bigScene = (n: number) => ({
  scene: "Level_01",
  objects: Array.from({ length: n }, (_, i) => ({ id: i, name: `Wall_${String(i).padStart(4, "0")}`, transform: { position: [i, 0, i * 2], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [{ type: "MeshRenderer", material: "Concrete" }, { type: "BoxCollider", size: [1, 1, 1] }], notes: "x".repeat(300) })),
  settings: { gravity: -9.81 },
});

describe("compactResult", () => {
  it("returns a result under the limit untouched", () => {
    const r = compactResult("small result", "mcp__unity__get_scene");
    expect(r).toEqual({ text: "small result", compacted: false, before: 12, after: 12 });
    const exactly = "x".repeat(DEFAULT_MAX_CHARS);
    expect(compactResult(exactly, "t").compacted).toBe(false);
  });

  it("shrinks a huge JSON scene to fit, keeps the first items and the top-level shape, and says what is missing", () => {
    const text = JSON.stringify(bigScene(5000));
    expect(text.length).toBeGreaterThan(1_000_000);
    const r = compactResult(text, "mcp__unity__get_scene");
    expect(r.compacted).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    expect(r.after).toBe(r.text.length);
    const [note, ...rest] = r.text.split(String.fromCharCode(10));
    expect(note).toContain("Result from mcp__unity__get_scene compacted locally");
    expect(note).toContain("Ask again with a narrower query");
    const parsed = JSON.parse(rest.join(String.fromCharCode(10))) as ReturnType<typeof bigScene>;
    expect(parsed.scene).toBe("Level_01"); // the top-level facts survive
    expect(parsed.settings).toEqual({ gravity: -9.81 });
    expect(parsed.objects[0]!.name).toBe("Wall_0000"); // the first items are real
    expect(parsed.objects.at(-1)).toMatch(/more items/); // and the rest is accounted for
    expect(String(parsed.objects.at(-1))).toContain("4,9"); // 4,9xx more
    expect(parsed.objects[0]!.notes.length).toBeLessThan(450); // long strings are cut, with the amount
  });

  it("keeps the whole result when a gentler cut is enough: a moderately big array keeps more of its items", () => {
    const text = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item ${i}` })));
    expect(text.length).toBeGreaterThan(DEFAULT_MAX_CHARS - 4000);
    const small = compactResult(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, name: "n".repeat(500) }))), "t");
    expect(small.compacted).toBe(true);
    const parsed = JSON.parse(small.text.split(String.fromCharCode(10)).slice(1).join(String.fromCharCode(10))) as unknown[];
    expect(parsed.length).toBeGreaterThanOrEqual(11); // the gentlest shape that fits was used, not the harshest
  });

  it("cuts very deep structures with a count instead of dropping them silently", () => {
    let deep: unknown = { leaf: "x".repeat(20_000) };
    for (let i = 0; i < 12; i++) deep = { [`level${i}`]: deep, filler: "y".repeat(100) };
    const r = compactResult(JSON.stringify(deep), "t");
    expect(r.compacted).toBe(true);
    expect(r.text).toMatch(/\{… \d+ keys\}|\[… \d+ items\]|characters\)/);
    expect(r.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
  });

  it("keeps the beginning and the END of plain text, because the cause of a failure is usually at the end of a log", () => {
    const log = Array.from({ length: 5000 }, (_, i) => `line ${i}: compiling module_${i}`).join(String.fromCharCode(10)) + `${String.fromCharCode(10)}error CS0103: The name 'Rigidbody2D' does not exist in the current context`;
    const r = compactResult(log, "mcp__unity__build");
    expect(r.compacted).toBe(true);
    expect(r.text).toContain("line 0: compiling module_0");
    expect(r.text).toContain("error CS0103: The name 'Rigidbody2D' does not exist");
    expect(r.text).toMatch(/\[… [\d,]+ characters omitted …\]/);
    expect(r.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    expect(r.text).not.toContain("line 2500:");
  });

  it("treats text that only looks like JSON as text, and honours a different limit", () => {
    const broken = "{" + "a".repeat(50_000);
    const r = compactResult(broken, "t");
    expect(r.compacted).toBe(true);
    expect(r.text).toContain("the beginning and the end are kept");
    const small = compactResult("z".repeat(5000), "t", 1000);
    expect(small.text.length).toBeLessThanOrEqual(1000);
    expect(small.text).toContain("compacted locally");
  });

  it("handles the extremes: an empty limit floor, scalars, and nulls", () => {
    expect(compactResult("x".repeat(500), "t", 10).text.length).toBeLessThan(1000);
    expect(compactResult("null", "t").compacted).toBe(false);
    const withNulls = JSON.stringify({ a: null, list: Array.from({ length: 3000 }, () => null) });
    expect(JSON.parse(compactResult(withNulls, "t").text.split(String.fromCharCode(10)).slice(1).join(String.fromCharCode(10))).a).toBeNull();
  });
});
