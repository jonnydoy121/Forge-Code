import { describe, expect, it } from "vitest";
import { InMemoryCheckpointStore } from "../src";

describe("CheckpointStore contract", () => {
  it("lists snapshots in order and rejects unknown restores", async () => {
    const s = new InMemoryCheckpointStore();
    await s.snapshot(["a.ts"], { step: 1 });
    await s.snapshot(["b.ts"]);
    expect((await s.list()).map((c) => c.id)).toEqual(["cp-1", "cp-2"]);
    await expect(s.restore("nope")).rejects.toThrow();
  });
});
