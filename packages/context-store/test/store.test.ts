import { describe, expect, it } from "vitest";
import { EmptyContextStore } from "../src";

describe("ContextStore contract", () => {
  it("has no rules by default", async () => {
    expect(await new EmptyContextStore().rulesFor()).toEqual([]);
  });
});
