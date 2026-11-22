import { describe, expect, it } from "vitest";
import { PendingChanges, revisePrompt, type DiskFs, type ReviewMode } from "../src";

function setup(mode: ReviewMode = "review", planFiles: string[] | null = null) {
  const disk = new Map<string, string>();
  const snapshots: { files: string[]; meta: unknown; before: (string | undefined)[] }[] = [];
  const fs: DiskFs = {
    read: async (p) => disk.get(p) ?? null,
    write: async (p, c) => void disk.set(p, c),
    remove: async (p) => void disk.delete(p),
  };
  let changes = 0;
  const p = new PendingChanges({
    fs,
    mode: () => mode,
    planFiles: () => planFiles,
    historyLength: () => 4,
    onChange: () => changes++,
    checkpoints: {
      snapshot: async (files, meta) => {
        snapshots.push({ files, meta, before: files.map((f) => disk.get(f)) });
        return { id: `cp-${snapshots.length}`, files, createdAt: 0, ...meta };
      },
    },
  });
  return { disk, p, snapshots, changes: () => changes };
}

const five = (changed: number[]) =>
  Array.from({ length: 50 }, (_, i) => (changed.includes(i) ? `CHANGED ${i}` : `line ${i}`)).join("\n");

describe("propose in review mode", () => {
  it("keeps the proposal pending, writes nothing to disk, and exposes it as an overlay", async () => {
    const { disk, p } = setup();
    disk.set("/ws/a.ts", "a\nb\nc");
    const r = await p.propose("/ws/a.ts", "a\nB\nc", "capitalise b");
    expect(r).toMatchObject({ status: "pending", stats: { added: 1, removed: 1 }, created: false });
    expect(disk.get("/ws/a.ts")).toBe("a\nb\nc");
    expect(p.effective("/ws/a.ts")).toBe("a\nB\nc");
    expect(p.effective("/ws/other.ts")).toBeUndefined();
  });

  it("accumulates repeated edits to one file against the original base and drops no-ops", async () => {
    const { disk, p } = setup();
    disk.set("/ws/a.ts", "a\nb\nc");
    await p.propose("/ws/a.ts", "a\nB\nc", "first");
    await p.propose("/ws/a.ts", "a\nB\nC", "second");
    const f = p.get("/ws/a.ts")!;
    expect(f.base).toBe("a\nb\nc");
    expect(f.hunks).toHaveLength(1); // adjacent changes form one hunk
    const back = await p.propose("/ws/a.ts", "a\nb\nc");
    expect(back.status).toBe("noop");
    expect(p.list()).toEqual([]);
  });

  it("records a reason per hunk and carries decisions over when a proposal is refined", async () => {
    const { disk, p } = setup();
    disk.set("/ws/f", five([]));
    await p.propose("/ws/f", five([2]), "reason A");
    const idA = p.get("/ws/f")!.hunks[0]!.id;
    await p.resolveHunk("/ws/f", idA, "accepted").catch(() => {});
    // After accepting the only hunk the file is finalised; start again with two hunks.
    disk.set("/ws/g", five([]));
    await p.propose("/ws/g", five([2]), "reason A");
    await p.propose("/ws/g", five([2, 40]), "reason B");
    const g = p.get("/ws/g")!;
    expect(g.hunks.map((h) => g.reasons[h.id])).toEqual(["reason A", "reason B"]);
  });
});

describe("per-hunk accept / reject (human control)", () => {
  it("rejecting one hunk of five applies the other four and checkpoints the write", async () => {
    const { disk, p, snapshots } = setup();
    const original = five([]);
    disk.set("/ws/big.ts", original);
    await p.propose("/ws/big.ts", five([2, 12, 22, 32, 42]), "refactor");
    const f = p.get("/ws/big.ts")!;
    expect(f.hunks).toHaveLength(5);
    for (const [i, h] of f.hunks.entries()) {
      const r = await p.resolveHunk("/ws/big.ts", h.id, i === 2 ? "rejected" : "accepted");
      expect(r.status).toBe(i === 4 ? "applied" : "open");
    }
    expect(disk.get("/ws/big.ts")).toBe(five([2, 12, 32, 42]));
    expect(p.list()).toEqual([]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.before[0]).toBe(original); // snapshot taken BEFORE the write
    expect(snapshots[0]!.meta).toMatchObject({ historyLength: 4 });
  });

  it("rejecting everything writes nothing and takes no checkpoint", async () => {
    const { disk, p, snapshots } = setup();
    disk.set("/ws/a", "a\nb");
    await p.propose("/ws/a", "a\nB");
    expect(await p.resolveEverything("rejected")).toEqual({ "/ws/a": "discarded" });
    expect(disk.get("/ws/a")).toBe("a\nb");
    expect(snapshots).toHaveLength(0);
  });

  it("accept all handles creation and deletion of files", async () => {
    const { disk, p } = setup();
    disk.set("/ws/old", "bye");
    await p.propose("/ws/new.ts", "export const a = 1;\n", "add");
    await p.propose("/ws/old", null, "remove");
    await p.resolveEverything("accepted");
    expect(disk.get("/ws/new.ts")).toBe("export const a = 1;\n");
    expect(disk.has("/ws/old")).toBe(false);
  });

  it("lets the developer edit a hunk before accepting it", async () => {
    const { disk, p } = setup();
    disk.set("/ws/a", "x\ny\nz");
    await p.propose("/ws/a", "x\nY\nz");
    const id = p.get("/ws/a")!.hunks[0]!.id;
    p.editHunk("/ws/a", id, ["Y-edited"]);
    await p.resolveAll("/ws/a", "accepted");
    expect(disk.get("/ws/a")).toBe("x\nY-edited\nz");
  });
});

describe("review modes", () => {
  it("auto applies everything immediately with a checkpoint", async () => {
    const { disk, p, snapshots } = setup("auto");
    disk.set("/ws/a", "a");
    const r = await p.propose("/ws/a", "b");
    expect(r.status).toBe("applied");
    expect(disk.get("/ws/a")).toBe("b");
    expect(snapshots).toHaveLength(1);
  });

  it("plan-files applies only files in the approved plan; others stay pending", async () => {
    const { disk, p } = setup("plan-files", ["/ws/in-plan.ts"]);
    disk.set("/ws/in-plan.ts", "1");
    disk.set("/ws/other.ts", "1");
    expect((await p.propose("/ws/in-plan.ts", "2")).status).toBe("applied");
    expect((await p.propose("/ws/other.ts", "2")).status).toBe("pending");
    expect(disk.get("/ws/other.ts")).toBe("1");
  });
});

describe("conflict handling", () => {
  it("merges cleanly when the developer edited a different region", async () => {
    const { disk, p } = setup();
    disk.set("/ws/f", five([]));
    await p.propose("/ws/f", five([40]), "agent");
    disk.set("/ws/f", five([]).replace("line 3", "dev edit")); // developer edits meanwhile
    const r = await p.resolveAll("/ws/f", "accepted");
    expect(r.status).toBe("applied");
    const out = disk.get("/ws/f")!.split("\n");
    expect(out[3]).toBe("dev edit");
    expect(out[40]).toBe("CHANGED 40");
  });

  it("never overwrites developer edits on conflict: surfaces a three-way merge instead", async () => {
    const { disk, p, snapshots } = setup();
    disk.set("/ws/f", "one\ntwo\nthree");
    await p.propose("/ws/f", "one\nTWO-agent\nthree", "agent");
    disk.set("/ws/f", "one\nTWO-dev\nthree");
    const r = await p.resolveAll("/ws/f", "accepted");
    expect(r.status).toBe("conflict");
    expect(disk.get("/ws/f")).toBe("one\nTWO-dev\nthree"); // untouched
    expect(snapshots).toHaveLength(0);
    const f = p.get("/ws/f")!;
    expect(f.conflict!.conflicts).toEqual([{ base: ["two"], ours: ["TWO-dev"], theirs: ["TWO-agent"] }]);
    expect(f.conflict!.merged).toContain("<<<<<<< disk");
    // developer resolves
    await p.resolveConflict("/ws/f", "one\nTWO-both\nthree");
    expect(disk.get("/ws/f")).toBe("one\nTWO-both\nthree");
    expect(p.list()).toEqual([]);
    expect(snapshots[0]!.before[0]).toBe("one\nTWO-dev\nthree"); // the developer's version is checkpointed
  });

  it("flags a conflict when the agent deletes a file the developer changed", async () => {
    const { disk, p } = setup();
    disk.set("/ws/f", "a");
    await p.propose("/ws/f", null);
    disk.set("/ws/f", "a-dev");
    expect((await p.resolveAll("/ws/f", "accepted")).status).toBe("conflict");
    expect(disk.get("/ws/f")).toBe("a-dev");
  });
});

describe("change sets", () => {
  it("groups pending files by change set and step", async () => {
    const { disk, p } = setup();
    disk.set("/ws/a", "1");
    disk.set("/ws/b", "1");
    disk.set("/ws/c", "1");
    p.beginChangeSet("Rename getById", 1);
    await p.propose("/ws/a", "2");
    await p.propose("/ws/b", "2");
    p.beginChangeSet("Update tests", 2);
    await p.propose("/ws/c", "2");
    const sets = p.changeSets();
    expect(sets.map((s) => [s.label, s.step, s.pending.map((f) => f.path)])).toEqual([
      ["Rename getById", 1, ["/ws/a", "/ws/b"]],
      ["Update tests", 2, ["/ws/c"]],
    ]);
    // accept just one change set
    await p.resolveEverything("accepted", sets[0]!.id);
    expect([disk.get("/ws/a"), disk.get("/ws/b"), disk.get("/ws/c")]).toEqual(["2", "2", "1"]);
  });
});

describe("revisePrompt", () => {
  it("targets only the commented hunk", async () => {
    const { disk, p } = setup();
    disk.set("/ws/a.ts", "x\nconsole.log(1)\nz");
    await p.propose("/ws/a.ts", "x\nconsole.error(1)\nz");
    const h = p.get("/ws/a.ts")!.hunks[0]!;
    const prompt = revisePrompt("/ws/a.ts", h, "use the existing logger here");
    expect(prompt).toContain("ONLY one hunk");
    expect(prompt).toContain("- console.log(1)\n+ console.error(1)");
    expect(prompt).toContain("use the existing logger here");
  });
});

describe("guard (weakening protection)", () => {
  it("forces flagged edits to wait for the developer even in auto mode", async () => {
    const disk = new Map<string, string>([["/ws/a.test.ts", "expect(a).toBe(1);"]]);
    const applied: string[] = [];
    const p = new PendingChanges({
      fs: { read: async (x) => disk.get(x) ?? null, write: async (x, c) => void disk.set(x, c), remove: async (x) => void disk.delete(x) },
      checkpoints: { snapshot: async (files, meta) => ({ id: "cp", files, createdAt: 0, ...meta }) },
      mode: () => "auto",
      guard: (_path, _base, proposed) => (proposed?.includes("skip") ? ["skips a test"] : []),
      onApplied: async (x) => void applied.push(x),
    });
    const flagged = await p.propose("/ws/a.test.ts", "it.skip('x')");
    expect(flagged).toMatchObject({ status: "pending", warnings: ["skips a test"] });
    expect(disk.get("/ws/a.test.ts")).toBe("expect(a).toBe(1);");
    expect(p.get("/ws/a.test.ts")!.warnings).toEqual(["skips a test"]);
    // a clean refinement clears the flag and auto-applies, firing onApplied
    const clean = await p.propose("/ws/a.test.ts", "expect(a).toBe(2);");
    expect(clean.status).toBe("applied");
    expect(applied).toEqual(["/ws/a.test.ts"]);
  });
});
