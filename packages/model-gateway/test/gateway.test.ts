import { describe, expect, it } from "vitest";
import { EchoGateway } from "../src";

describe("ModelGateway contract", () => {
  it("streams text then a terminal done event", async () => {
    const events = [];
    const req = { provider: "echo", model: "echo", messages: [{ role: "user" as const, content: "hi" }] };
    for await (const e of new EchoGateway().stream(req)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
  });
});
