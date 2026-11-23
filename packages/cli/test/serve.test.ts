import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedGateway } from "@forge/model-gateway";
import type { StreamEvent } from "@forge/protocol";
import { createAskServer, runServe } from "../src/serve";

const done: StreamEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
const TOKEN = "a-long-enough-secret";
let closer: (() => void) | null = null;
afterEach(() => closer?.());

async function start(gateway: ScriptedGateway) {
  const io = { out: () => undefined, err: () => undefined, env: {}, cwd: mkdtempSync(join(tmpdir(), "forge-serve-")), gateway };
  const server = createAskServer(TOKEN, io);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closer = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, path = "/ask") => fetch(url + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("forge-code serve", () => {
  it("answers a question for a caller with the token", async () => {
    const gw = new ScriptedGateway([[{ type: "text", delta: "Forty-two." }, done]]);
    const post = await start(gw);
    const r = await post({ prompt: "meaning of life?" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { result: { answer: string } }).result.answer).toBe("Forty-two.");
    expect(gw.requests[0]!.messages.at(-1)!.content).toContain("meaning of life?");
  });

  it("refuses a missing or wrong token without running the model", async () => {
    const gw = new ScriptedGateway([]);
    const post = await start(gw);
    expect((await post({ prompt: "x" }, {})).status).toBe(401);
    expect((await post({ prompt: "x" }, { authorization: "Bearer wrong-token-of-length" })).status).toBe(401);
    expect(gw.requests).toHaveLength(0);
  });

  it("rejects bad bodies, other paths and oversized requests", async () => {
    const post = await start(new ScriptedGateway([]));
    expect((await post("not json")).status).toBe(400);
    expect((await post({ prompt: "  " })).status).toBe(400);
    expect((await post({ prompt: "x" }, { authorization: `Bearer ${TOKEN}` }, "/other")).status).toBe(404);
    expect((await post({ prompt: "x".repeat(70_000) })).status).toBe(413);
  });

  it("will not start without a long enough secret", async () => {
    const err: string[] = [];
    const code = await runServe([], { out: () => undefined, err: (t) => err.push(t), env: { FORGE_SERVE_TOKEN: "short" }, cwd: "." });
    expect(code).toBe(1);
    expect(err.join("")).toContain("FORGE_SERVE_TOKEN");
  });
});
