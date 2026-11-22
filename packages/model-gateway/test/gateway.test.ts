import { describe, expect, it } from "vitest";
import type { ModelRequest, StreamEvent } from "@forge/protocol";
import { EchoGateway, Gateway, parseSse, type FetchLike } from "../src";

const enc = new TextEncoder();
function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status });
}
const collect = async (it: AsyncIterable<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const req = (provider: string): ModelRequest => ({
  provider,
  model: "claude-sonnet-5-5",
  messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
  tools: [{ name: "read_file", description: "d", parameters: { type: "object" }, class: "read" }],
});

describe("EchoGateway", () => {
  it("streams text then done", async () => {
    const r = { provider: "e", model: "e", messages: [{ role: "user" as const, content: "hi" }] };
    expect((await collect(new EchoGateway().stream(r))).map((e) => e.type)).toEqual(["text", "done"]);
  });
});

describe("parseSse", () => {
  it("handles events split across chunks and CRLF", async () => {
    const body = sseResponse(['event: a\r\ndata: {"x"', ":1}\r\n\r\ndata: two\n\n"]).body!;
    const events = [];
    for await (const e of parseSse(body)) events.push(e);
    expect(events).toEqual([{ event: "a", data: '{"x":1}' }, { event: undefined, data: "two" }]);
  });
});

describe("Anthropic adapter", () => {
  const stream = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1000}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"read_file"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}\n\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'data: {"type":"message_delta","usage":{"output_tokens":500}}\n\n',
  ];

  it("streams text, assembles tool calls and prices usage", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn: FetchLike = async (url, init) => ((seen = { url, init }), sseResponse(stream));
    const gw = new Gateway({ fetch: fetchFn });
    gw.register("anthropic", { kind: "anthropic", apiKey: "k" });
    const events = await collect(gw.stream(req("anthropic")));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Hello");
    expect(events.find((e) => e.type === "tool_call")).toEqual({ type: "tool_call", call: { id: "tu_1", name: "read_file", args: { path: "a.ts" } } });
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.usage.costUsd).toBeCloseTo((1000 * 3 + 500 * 15) / 1e6);
    const body = JSON.parse(seen!.init.body as string);
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.tools[0].input_schema).toEqual({ type: "object" });
    expect((seen!.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });
});

describe("OpenAI-compatible adapter (Ollama)", () => {
  it("assembles streamed tool calls and reports zero cost locally", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"ok "}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ls","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\".\\"}"}}]}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ];
    const gw = new Gateway({ fetch: async () => sseResponse(chunks) });
    gw.register("local", { kind: "ollama" });
    const events = await collect(gw.stream(req("local")));
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ call: { id: "c1", name: "ls", args: { path: "." } } });
    expect((events.at(-1) as Extract<StreamEvent, { type: "done" }>).usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0 });
  });
});

describe("Gateway retries and audit", () => {
  it("retries 429 then succeeds, with backoff", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const gw = new Gateway({
      fetch: async () => (++n < 3 ? new Response("slow down", { status: 429 }) : sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', "data: [DONE]\n\n"])),
      sleep: async (ms) => void sleeps.push(ms),
    });
    gw.register("o", { kind: "openai", apiKey: "k" });
    expect((await collect(gw.stream(req("o")))).some((e) => e.type === "text")).toBe(true);
    expect(n).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("does not retry 4xx", async () => {
    let n = 0;
    const gw = new Gateway({ fetch: async () => (n++, new Response("bad key", { status: 401 })), sleep: async () => {} });
    gw.register("o", { kind: "openai" });
    await expect(collect(gw.stream(req("o")))).rejects.toThrow("HTTP 401");
    expect(n).toBe(1);
  });

  it("reports local vs remote requests to the audit hook", async () => {
    const seen: boolean[] = [];
    const gw = new Gateway({ fetch: async () => sseResponse(["data: [DONE]\n\n"]), onRequest: (i) => seen.push(i.local) });
    gw.register("local", { kind: "ollama" });
    gw.register("remote", { kind: "openai" });
    await collect(gw.stream(req("local")));
    await collect(gw.stream(req("remote")));
    expect(seen).toEqual([true, false]);
  });
});
