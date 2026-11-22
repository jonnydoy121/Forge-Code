import { describe, expect, it } from "vitest";
import { FileCheckpointStore, InMemoryCheckpointStore, MemoryFs } from "../src";

const setup = () => {
  const fs = new MemoryFs();
  const store = new FileCheckpointStore({ fs, dir: "/ws/.forge/checkpoints/s1" });
  return { fs, store };
};

describe("CheckpointStore contract", () => {
  it("lists snapshots in order and rejects unknown restores", async () => {
    const s = new InMemoryCheckpointStore();
    await s.snapshot(["a.ts"], { step: 1 });
    await s.snapshot(["b.ts"]);
    expect((await s.list()).map((c) => c.id)).toEqual(["cp-00001", "cp-00002"]);
    await expect(s.restore("nope")).rejects.toThrow("unknown checkpoint");
  });
});

describe("snapshot and restore", () => {
  it("restores edited and created files exactly (including deleting files that did not exist)", async () => {
    const { fs, store } = setup();
    fs.files.set("/ws/a.ts", "original a\r\nline2\r\n");
    const cp = await store.snapshot(["/ws/a.ts", "/ws/new.ts"], { step: 1 });
    fs.files.set("/ws/a.ts", "edited");
    fs.files.set("/ws/new.ts", "created by agent");
    await store.restore(cp.id);
    expect(fs.files.get("/ws/a.ts")).toBe("original a\r\nline2\r\n");
    expect(fs.files.has("/ws/new.ts")).toBe(false);
  });

  it("restores a single file from a multi-file checkpoint", async () => {
    const { fs, store } = setup();
    fs.files.set("/ws/a", "A0");
    fs.files.set("/ws/b", "B0");
    const cp = await store.snapshot(["/ws/a", "/ws/b"]);
    fs.files.set("/ws/a", "A1");
    fs.files.set("/ws/b", "B1");
    await store.restore(cp.id, { file: "/ws/a" });
    expect([fs.files.get("/ws/a"), fs.files.get("/ws/b")]).toEqual(["A0", "B1"]);
  });
});

describe("rollback granularity", () => {
  it("rolls back a step: each file returns to its content before the earliest edit in that step", async () => {
    const { fs, store } = setup();
    fs.files.set("/ws/a", "a0");
    fs.files.set("/ws/b", "b0");
    await store.snapshot(["/ws/a"], { step: 1 });
    fs.files.set("/ws/a", "a1");
    await store.snapshot(["/ws/a", "/ws/b"], { step: 2 });
    fs.files.set("/ws/a", "a2");
    fs.files.set("/ws/b", "b2");
    await store.snapshot(["/ws/a"], { step: 2 });
    fs.files.set("/ws/a", "a3");
    expect(await store.rollback({ step: 2 })).toEqual(["/ws/a", "/ws/b"]);
    expect([fs.files.get("/ws/a"), fs.files.get("/ws/b")]).toEqual(["a1", "b0"]);
  });

  it("rolls back a change set, a single file, and back to a checkpoint (whole session)", async () => {
    const { fs, store } = setup();
    fs.files.set("/ws/a", "a0");
    fs.files.set("/ws/b", "b0");
    const c1 = await store.snapshot(["/ws/a", "/ws/b"], { changeSet: "x" });
    fs.files.set("/ws/a", "a1");
    fs.files.set("/ws/b", "b1");
    await store.snapshot(["/ws/a"], { changeSet: "y" });
    fs.files.set("/ws/a", "a2");
    await store.rollback({ changeSet: "y" });
    expect(fs.files.get("/ws/a")).toBe("a1");
    await store.rollback({ changeSet: "x", file: "/ws/b" });
    expect([fs.files.get("/ws/a"), fs.files.get("/ws/b")]).toEqual(["a1", "b0"]);
    await store.rollback({ toCheckpoint: c1.id });
    expect([fs.files.get("/ws/a"), fs.files.get("/ws/b")]).toEqual(["a0", "b0"]);
  });

  it("a rollback is itself checkpointed so it can be undone", async () => {
    const { fs, store } = setup();
    fs.files.set("/ws/a", "a0");
    await store.snapshot(["/ws/a"], { step: 1 });
    fs.files.set("/ws/a", "a1");
    await store.rollback({ step: 1 });
    expect(fs.files.get("/ws/a")).toBe("a0");
    const last = (await store.list()).at(-1)!;
    expect(last.label).toBe("before rollback");
    await store.restore(last.id);
    expect(fs.files.get("/ws/a")).toBe("a1");
  });

  it("rolls back one hunk and leaves the others", async () => {
    const { fs, store } = setup();
    const base = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
    fs.files.set("/ws/f", base);
    const cp = await store.snapshot(["/ws/f"]);
    fs.files.set("/ws/f", ["ONE", "two", "three", "four", "five", "six", "SEVEN"].join("\n"));
    const hunks = await store.hunksSince(cp.id, "/ws/f");
    expect(hunks).toHaveLength(2);
    await store.rollbackHunk(cp.id, "/ws/f", hunks[1]!.id);
    expect(fs.files.get("/ws/f")).toBe(["ONE", "two", "three", "four", "five", "six", "seven"].join("\n"));
    await expect(store.rollbackHunk(cp.id, "/ws/f", "bogus")).rejects.toThrow("not found");
  });
});

describe("persistence and retention", () => {
  it("survives a restart by reloading from disk", async () => {
    const { fs, store } = setup();
    fs.files.set("/ws/a", "a0");
    await store.snapshot(["/ws/a"], { step: 3, historyLength: 7 });
    const again = new FileCheckpointStore({ fs, dir: "/ws/.forge/checkpoints/s1" });
    const [cp] = await again.list();
    expect(cp).toMatchObject({ id: "cp-00001", step: 3, historyLength: 7, files: ["/ws/a"] });
    fs.files.set("/ws/a", "changed");
    await again.restore(cp!.id);
    expect(fs.files.get("/ws/a")).toBe("a0");
    // sequence continues after reload (the restore above took cp-00002 as its own safety snapshot)
    expect((await again.snapshot(["/ws/a"])).id).toBe("cp-00003");
  });

  it("keeps at least 100 checkpoints", async () => {
    const { fs, store } = setup();
    fs.files.set("/ws/a", "x");
    for (let i = 0; i < 130; i++) await store.snapshot(["/ws/a"]);
    expect((await store.list()).length).toBe(130);
  });

  it("skips corrupt checkpoint files instead of failing", async () => {
    const { fs, store } = setup();
    fs.files.set("/ws/.forge/checkpoints/s1/cp-00001.json", "{not json");
    expect(await store.list()).toEqual([]);
  });
});
