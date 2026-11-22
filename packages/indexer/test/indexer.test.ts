import { describe, expect, it } from "vitest";
import { EmptyIndexer } from "../src";

describe("Indexer contract", () => {
  it("returns empty results before indexing", async () => {
    const i = new EmptyIndexer();
    expect(await i.grep("x")).toEqual([]);
    expect(await i.symbol("x")).toBeUndefined();
  });
});
