import { describe, expect, it } from "vitest";
import { StubToolHost } from "../src";

describe("ToolHost mode enforcement", () => {
  const host = new StubToolHost();
  it("does not expose write/execute tools in ask mode", () => {
    expect(host.listTools("ask").map((t) => t.name)).toEqual(["read_file"]);
  });
  it("rejects a write call in plan mode even if the model asks for it", async () => {
    const r = await host.call("plan", { id: "1", name: "write_file", args: {} });
    expect(r.ok).toBe(false);
  });
  it("exposes everything in agent mode", () => {
    expect(host.listTools("agent")).toHaveLength(3);
  });
});
