import { describe, expect, it } from "vitest";
import { AGENT, EXPLORER, MIN_CENTER, clamp, loadLayout, maxFor, saveLayout, stepWidth } from "./layout";

const store = (initial?: string) => {
  let v = initial ?? null;
  return { getItem: () => v, setItem: (_k: string, x: string) => void (v = x), get value() { return v; } };
};

describe("layout", () => {
  it("keeps a width inside its limits, and never inverts them", () => {
    expect(clamp(50, 160, 480)).toBe(160);
    expect(clamp(900, 160, 480)).toBe(480);
    expect(clamp(300.4, 160, 480)).toBe(300);
    expect(clamp(300, 160, 100)).toBe(160); // a max below the min (a tiny window) gives the min, not nonsense
  });

  it("leaves the editor its room when a panel is made wider", () => {
    expect(maxFor(AGENT, 1400, 240)).toBe(AGENT.max); // plenty of room: the panel's own limit
    expect(maxFor(AGENT, 900, 240)).toBe(900 - 240 - MIN_CENTER);
    expect(maxFor(EXPLORER, 500, 384)).toBe(EXPLORER.min); // a tiny window: never below the minimum
  });

  it("steps with the arrow keys the right way round for a panel left or right of its splitter", () => {
    expect(stepWidth("ArrowRight", false, 240, 160, 480, 1)).toBe(256); // explorer: right widens
    expect(stepWidth("ArrowLeft", false, 240, 160, 480, 1)).toBe(224);
    expect(stepWidth("ArrowLeft", false, 384, 300, 760, -1)).toBe(400); // agent: left widens
    expect(stepWidth("ArrowRight", true, 384, 300, 760, -1)).toBe(320); // shift: bigger steps
    expect(stepWidth("ArrowRight", false, 480, 160, 480, 1)).toBe(480); // stops at the limit
  });

  it("jumps to the limits with Home and End, and ignores other keys", () => {
    expect(stepWidth("Home", false, 300, 160, 480, 1)).toBe(160);
    expect(stepWidth("End", false, 300, 160, 480, 1)).toBe(480);
    expect(stepWidth("a", false, 300, 160, 480, 1)).toBeNull();
    expect(stepWidth("Enter", false, 300, 160, 480, 1)).toBeNull();
  });

  it("remembers sizes between sessions, and falls back to the defaults for nothing, junk or out-of-range values", () => {
    const s = store();
    saveLayout({ explorer: 300, agent: 500 }, s);
    expect(loadLayout(s)).toEqual({ explorer: 300, agent: 500 });
    expect(loadLayout(store())).toEqual({ explorer: EXPLORER.def, agent: AGENT.def });
    expect(loadLayout(store("{not json"))).toEqual({ explorer: EXPLORER.def, agent: AGENT.def });
    expect(loadLayout(store('{"explorer":"wide","agent":null}'))).toEqual({ explorer: EXPLORER.def, agent: AGENT.def });
    expect(loadLayout(store('{"explorer":5000,"agent":1}'))).toEqual({ explorer: EXPLORER.max, agent: AGENT.min });
  });

  it("does not throw when storage is unavailable", () => {
    expect(() => saveLayout({ explorer: 200, agent: 400 }, { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });
});
