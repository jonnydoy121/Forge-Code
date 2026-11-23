import { describe, expect, it } from "vitest";
import { latestOnly } from "./latestOnly";

/** A promise resolved or rejected by hand, so the order in which loads finish is the test's choice. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("latestOnly", () => {
  it("applies a result when nothing newer has started", async () => {
    const seen: string[] = [];
    const load = latestOnly<string>((v) => seen.push(v));
    load.run(Promise.resolve("a"));
    await settle();
    expect(seen).toEqual(["a"]);
  });

  it("drops a slow older load that finishes AFTER a newer one: the situation that made the rules list wrong", async () => {
    const seen: string[] = [];
    const load = latestOnly<string>((v) => seen.push(v));
    const slow = deferred<string>();
    const fast = deferred<string>();
    load.run(slow.promise); // for the first file
    load.run(fast.promise); // for the file that is active now
    fast.resolve("rules of the active file");
    await settle();
    slow.resolve("rules of the earlier file");
    await settle();
    expect(seen).toEqual(["rules of the active file"]); // the stale one never lands
  });

  it("does not apply the older result even if it arrives first and the newer one is still running", async () => {
    const seen: string[] = [];
    const load = latestOnly<string>((v) => seen.push(v));
    const first = deferred<string>();
    const second = deferred<string>();
    load.run(first.promise);
    load.run(second.promise);
    first.resolve("old");
    await settle();
    expect(seen).toEqual([]); // the old answer is already out of date
    second.resolve("new");
    await settle();
    expect(seen).toEqual(["new"]);
  });

  it("in a burst of loads finishing in a scrambled order only the last started counts", async () => {
    const seen: number[] = [];
    const load = latestOnly<number>((v) => seen.push(v));
    const loads = Array.from({ length: 6 }, () => deferred<number>());
    loads.forEach((d) => load.run(d.promise));
    for (const i of [3, 0, 5, 1, 4, 2]) {
      loads[i]!.resolve(i);
      await settle();
    }
    expect(seen).toEqual([5]);
  });

  it("drops what is in flight when cancelled (the component went away, or the effect re-ran)", async () => {
    const seen: string[] = [];
    const load = latestOnly<string>((v) => seen.push(v));
    const d = deferred<string>();
    load.run(d.promise);
    load.cancel();
    d.resolve("too late");
    await settle();
    expect(seen).toEqual([]);
  });

  it("ignores a failed load, quietly, whether it is stale or current", async () => {
    const seen: string[] = [];
    const load = latestOnly<string>((v) => seen.push(v));
    const bad = deferred<string>();
    load.run(bad.promise);
    bad.reject(new Error("boom"));
    await settle(); // would be an unhandled rejection if it were not handled
    load.run(Promise.resolve("fine"));
    await settle();
    expect(seen).toEqual(["fine"]);
  });

  it("runOr reports a failure of the current load, but not of a superseded one", async () => {
    const errors: string[] = [];
    const load = latestOnly<string>(() => {});
    const stale = deferred<string>();
    const current = deferred<string>();
    load.runOr(stale.promise, (e) => errors.push(`stale:${String(e)}`));
    load.runOr(current.promise, (e) => errors.push(`current:${String(e)}`));
    stale.reject("a");
    current.reject("b");
    await settle();
    expect(errors).toEqual(["current:b"]);
  });
});
