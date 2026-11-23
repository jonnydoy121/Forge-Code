import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@forge/protocol";
import { Gateway, parsePrices, priceOf, usageCost, type FetchLike } from "../src";

const enc = new TextEncoder();
const sse = (...objs: unknown[]) => objs.map((o) => `data: ${JSON.stringify(o)}${String.fromCharCode(10)}${String.fromCharCode(10)}`);
const response = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({ start: (c) => (chunks.forEach((x) => c.enqueue(enc.encode(x))), c.close()) }), { status: 200 });
const collect = async (it: AsyncIterable<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const x of it) out.push(x);
  return out;
};
const cost = (events: StreamEvent[]) => (events.at(-1) as Extract<StreamEvent, { type: "done" }>).usage.costUsd;

describe("parsePrices", () => {
  it("reads one model per line, in USD per million tokens, with an optional cache-read fraction", () => {
    const r = parsePrices("gpt-4o 2.5 10\n# a comment\n\nmy/model:7b 0 0\nclaude-x 3 15 0.25");
    expect(r.errors).toEqual([]);
    expect(r.prices).toEqual({ "gpt-4o": { input: 2.5, output: 10, cacheRead: 0.1 }, "my/model:7b": { input: 0, output: 0, cacheRead: 0.1 }, "claude-x": { input: 3, output: 15, cacheRead: 0.25 } });
  });

  it("reports bad lines by number and keeps the good ones (including Windows line endings)", () => {
    const r = parsePrices(["good 1 2", "just-a-name", "bad-number 1 abc", "negative 1 -2", "too many 1 2 3 4"].join("\r\n"));
    expect(Object.keys(r.prices)).toEqual(["good"]);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(r.errors[0]!.message).toContain("expected");
    expect(r.errors[2]!.message).toContain("zero or more");
  });

  it("is empty for empty input", () => {
    expect(parsePrices("")).toEqual({ prices: {}, errors: [] });
  });
});

describe("priceOf and custom prices", () => {
  it("prefers the user's price over the built-in table and knows nothing about unlisted models", () => {
    expect(priceOf("claude-sonnet-5-5")).toMatchObject({ input: 2 });
    expect(priceOf("claude-sonnet-5-5", { "claude-sonnet-5-5": { input: 9, output: 9, cacheRead: 0.1 } })).toMatchObject({ input: 9 });
    expect(priceOf("gpt-4o")).toBeUndefined();
    expect(priceOf("gpt-4o", { "gpt-4o": { input: 2.5, output: 10, cacheRead: 0.5 } })).toMatchObject({ output: 10 });
    expect(usageCost("gpt-4o", { input: 1_000_000, output: 1_000_000 })).toBe(0);
    expect(usageCost("gpt-4o", { input: 1_000_000, output: 1_000_000 }, { "gpt-4o": { input: 2.5, output: 10, cacheRead: 0.5 } })).toBeCloseTo(12.5);
  });
});

describe("the gateway applies custom prices", () => {
  const openai = sse({ choices: [{ delta: { content: "x" } }] }, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } });

  it("counts a remote OpenAI-compatible model once it has a price, and picks up later changes without a new gateway", async () => {
    const gw = new Gateway({ fetch: (async () => response(openai)) as FetchLike });
    gw.register("o", { kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k" });
    const ask = () => collect(gw.stream({ provider: "o", model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }));
    expect(cost(await ask())).toBe(0); // no price known: not counted
    gw.setPrices({ "gpt-4o": { input: 2.5, output: 10, cacheRead: 0.5 } });
    expect(cost(await ask())).toBeCloseTo((1000 * 2.5 + 100 * 10) / 1e6);
    gw.setPrices({});
    expect(cost(await ask())).toBe(0);
  });

  it("discounts cached prompt tokens on an OpenAI-compatible provider at the cache rate, not the full input rate", async () => {
    const stream = sse({ choices: [{ delta: { content: "x" } }] }, { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 2000 } } });
    const gw = new Gateway({ fetch: (async () => response(stream)) as FetchLike });
    gw.register("o", { kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k" });
    gw.setPrices({ "gpt-4o": { input: 2.5, output: 10, cacheRead: 0.5 } });
    const events = await collect(gw.stream({ provider: "o", model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }));
    expect(cost(events)).toBeCloseTo((1000 * 2.5 + 2000 * 2.5 * 0.5 + 100 * 10) / 1e6, 10); // 1,000 fresh + 2,000 cached, not 3,000 fresh
    expect((events.at(-1) as Extract<StreamEvent, { type: "done" }>).usage.inputTokens).toBe(3000); // the whole prompt is still what is reported
  });

  it("applies to Anthropic models the built-in table lacks, including cache reads", async () => {
    const stream = sse({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 1000 } } }, { type: "message_delta", usage: { output_tokens: 10 } });
    const gw = new Gateway({ fetch: (async () => response(stream)) as FetchLike });
    gw.register("a", { kind: "anthropic", apiKey: "k" });
    gw.setPrices({ "claude-new": { input: 3, output: 15, cacheRead: 0.1 } });
    const events = await collect(gw.stream({ provider: "a", model: "claude-new", messages: [{ role: "user", content: "hi" }] }));
    expect(cost(events)).toBeCloseTo((100 * 3 + 1000 * 3 * 0.1 + 10 * 15) / 1e6);
  });

  it("never charges for a model on this machine, whatever price is set for it", async () => {
    const gw = new Gateway({ fetch: (async () => response(openai)) as FetchLike });
    gw.register("l", { kind: "ollama" });
    gw.setPrices({ "qwen2.5-coder:7b": { input: 5, output: 5, cacheRead: 0.1 } });
    expect(cost(await collect(gw.stream({ provider: "l", model: "qwen2.5-coder:7b", messages: [{ role: "user", content: "hi" }] })))).toBe(0);
  });
});
