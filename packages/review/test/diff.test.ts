import { describe, expect, it } from "vitest";
import { applyHunks, diffHunks, joinLines, merge3, splitLines, statsOf, wordDiff, withContext } from "../src";

const L = (s: string) => splitLines(s);

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function randomText(r: () => number, lines: number, alphabet = 6) {
  return Array.from({ length: lines }, () => `line ${Math.floor(r() * alphabet)}`).join("\n");
}
function mutate(r: () => number, text: string) {
  const ls = L(text);
  for (let k = 0; k < 1 + Math.floor(r() * 4); k++) {
    const i = Math.floor(r() * (ls.length + 1));
    const op = r();
    if (op < 0.4) ls.splice(i, 0, `new ${Math.floor(r() * 100)}`);
    else if (op < 0.7 && ls.length > 1) ls.splice(Math.min(i, ls.length - 1), 1);
    else if (ls.length) ls[Math.min(i, ls.length - 1)] = `changed ${Math.floor(r() * 100)}`;
  }
  return joinLines(ls);
}

describe("diffHunks / applyHunks", () => {
  it("finds minimal hunks for simple edits", () => {
    const h = diffHunks(L("a\nb\nc\nd"), L("a\nB\nc\nd\ne"));
    expect(h.map((x) => [x.oldStart, x.oldLines, x.newLines])).toEqual([
      [1, ["b"], ["B"]],
      [4, [], ["e"]],
    ]);
    expect(statsOf(h)).toEqual({ added: 2, removed: 1 });
  });

  it("identical text has no hunks", () => {
    expect(diffHunks(L("x\ny"), L("x\ny"))).toEqual([]);
  });

  it("handles empty-to-text and text-to-empty", () => {
    expect(applyHunks(L(""), diffHunks(L(""), L("a\nb")), () => true)).toEqual(L("a\nb"));
    expect(applyHunks(L("a\nb"), diffHunks(L("a\nb"), L("")), () => true)).toEqual(L(""));
  });

  it("property: accepting all hunks yields the new text, none yields the old, any subset is consistent", () => {
    const r = rng(42);
    for (let n = 0; n < 300; n++) {
      const old = randomText(r, 1 + Math.floor(r() * 40));
      const neu = mutate(r, old);
      const hunks = diffHunks(L(old), L(neu));
      expect(joinLines(applyHunks(L(old), hunks, () => true))).toBe(neu);
      expect(joinLines(applyHunks(L(old), hunks, () => false))).toBe(old);
      // each single accepted hunk changes exactly that region
      for (const h of hunks) {
        const only = applyHunks(L(old), hunks, (x) => x.id === h.id);
        expect(only.length).toBe(L(old).length - h.oldLines.length + h.newLines.length);
      }
    }
  });

  it("property: diff is minimal enough that unrelated lines stay untouched", () => {
    const old = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join("\n");
    const lines = L(old);
    lines[1000] = "edited";
    const h = diffHunks(L(old), lines);
    expect(h).toHaveLength(1);
    expect(h[0]!.oldLines).toEqual(["row 1000"]);
  });

  it("preserves CRLF exactly through a round trip", () => {
    const old = "a\r\nb\r\nc\r\n";
    const neu = "a\r\nB\r\nc\r\n";
    const out = joinLines(applyHunks(L(old), diffHunks(L(old), L(neu)), () => true));
    expect(out).toBe(neu);
  });
});

describe("wordDiff / context", () => {
  it("highlights only the changed words", () => {
    const d = wordDiff("const total = items.length;", "const total = list.length;");
    expect(d.old.filter((s) => s.changed).map((s) => s.text)).toEqual(["items"]);
    expect(d.new.filter((s) => s.changed).map((s) => s.text)).toEqual(["list"]);
    expect(d.old.map((s) => s.text).join("")).toBe("const total = items.length;");
  });
  it("returns surrounding context", () => {
    const old = L("1\n2\n3\n4\n5\n6\n7");
    const [h] = diffHunks(old, L("1\n2\n3\nX\n5\n6\n7"));
    expect(withContext(old, h!, 2)).toEqual({ before: ["2", "3"], after: ["5", "6"], startLine: 2 });
  });
});

describe("merge3", () => {
  const base = "one\ntwo\nthree\nfour\nfive";
  it("merges non-overlapping edits from both sides", () => {
    const ours = "ONE\ntwo\nthree\nfour\nfive";
    const theirs = "one\ntwo\nthree\nfour\nFIVE";
    const m = merge3(base, ours, theirs);
    expect(m.clean).toBe(true);
    expect(m.text).toBe("ONE\ntwo\nthree\nfour\nFIVE");
  });
  it("takes one side when the other did not change", () => {
    expect(merge3(base, base, "one\n2\nthree\nfour\nfive").text).toBe("one\n2\nthree\nfour\nfive");
    expect(merge3(base, "one\n2\nthree\nfour\nfive", base).text).toBe("one\n2\nthree\nfour\nfive");
  });
  it("accepts identical changes on both sides", () => {
    const x = "one\n2\nthree\nfour\nfive";
    expect(merge3(base, x, x).clean).toBe(true);
  });
  it("reports overlapping different edits as a conflict with markers and never picks a side", () => {
    const m = merge3(base, "one\nTWO-dev\nthree\nfour\nfive", "one\nTWO-agent\nthree\nfour\nfive");
    expect(m.clean).toBe(false);
    expect(m.conflicts).toEqual([{ base: ["two"], ours: ["TWO-dev"], theirs: ["TWO-agent"] }]);
    expect(m.text).toContain("<<<<<<< disk\nTWO-dev\n=======\nTWO-agent\n>>>>>>> agent");
  });
  it("property: with no developer edits the merge equals the agent text; with no agent edits it equals disk", () => {
    const r = rng(7);
    for (let n = 0; n < 300; n++) {
      const b = randomText(r, 1 + Math.floor(r() * 30));
      const edited = mutate(r, b);
      expect(merge3(b, b, edited).text).toBe(edited);
      expect(merge3(b, edited, b).text).toBe(edited);
    }
  });
  it("property: merged result keeps both sides' edits when they are far apart", () => {
    const b = Array.from({ length: 100 }, (_, i) => `row ${i}`).join("\n");
    const ours = L(b);
    ours[5] = "dev edit";
    const theirs = L(b);
    theirs[90] = "agent edit";
    const m = merge3(b, joinLines(ours), joinLines(theirs));
    expect(m.clean).toBe(true);
    expect(m.lines[5]).toBe("dev edit");
    expect(m.lines[90]).toBe("agent edit");
  });
});
