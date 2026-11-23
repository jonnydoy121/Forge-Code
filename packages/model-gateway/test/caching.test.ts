import { describe, expect, it } from "vitest";
import type { ModelRequest, StreamEvent } from "@forge/protocol";
import { Gateway, PRICES, usageCost, type FetchLike } from "../src";

const enc = new TextEncoder();
const sseResponse = (chunks: string[]) =>
  new Response(new ReadableStream<Uint8Array>({ start: (c) => (chunks.forEach((x) => c.enqueue(enc.encode(x))), c.close()) }), { status: 200 });
const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};
const done = (events: StreamEvent[]) => events.at(-1) as Extract<StreamEvent, { type: "done" }>;

const NL = String.fromCharCode(10);
const sse = (...objs: unknown[]) => objs.map((o) => `data: ${JSON.stringify(o)}${NL}${NL}`);

describe("usage cost", () => {
  it("prices cache reads and writes at their own rates", () => {
    // Sonnet 5.5: $2 in, $10 out, reads at 0.05x, writes at 1.25x.
    const c = usageCost("claude-sonnet-5-5", { input: 100, output: 500, cacheRead: 10_000, cacheWrite: 2_000 });
    expect(c).toBeCloseTo((100 * 2 + 2_000 * 2 * 1.25 + 10_000 * 2 * 0.05 + 500 * 10) / 1e6, 10);
  });

  it("uses each model's own cache-read multiplier", () => {
    const read = (model: string) => usageCost(model, { input: 0, output: 0, cacheRead: 1_000_000 });
    expect(read("claude-opus-5-5")).toBeCloseTo(0.2); // $4 x 0.05
    expect(read("claude-sonnet-5-5")).toBeCloseTo(0.1); // $2 x 0.05
    expect(read("claude-fable-5-2")).toBeCloseTo(0.2); // $8 x 0.025
    // Haiku: $0.10 x 0.1 per million for prompts up to 100k tokens, $0.50 x 0.1 above that.
    expect(usageCost("claude-haiku-5-5", { input: 0, output: 0, cacheRead: 50_000 })).toBeCloseTo((50_000 * 0.1 * 0.1) / 1e6, 10);
    expect(read("claude-haiku-5-5")).toBeCloseTo(0.05);
  });

  it("bills a long Haiku prompt at the higher rates, counting cached tokens toward its length", () => {
    expect(usageCost("claude-haiku-5-5", { input: 50_000, output: 1_000 })).toBeCloseTo((50_000 * 0.1 + 1_000 * 0.5) / 1e6, 10);
    expect(usageCost("claude-haiku-5-5", { input: 10_000, output: 1_000, cacheRead: 95_000 })).toBeCloseTo((10_000 * 0.5 + 95_000 * 0.5 * 0.1 + 1_000 * 2.5) / 1e6, 10);
  });

  it("costs nothing for models it has no price for (local models, other providers)", () => {
    expect(usageCost("qwen2.5-coder:7b", { input: 1e6, output: 1e6, cacheRead: 1e6 })).toBe(0);
    expect(Object.keys(PRICES)).toContain("claude-opus-5-5");
  });
});

describe("Anthropic prompt caching", () => {
  const request = (messages: ModelRequest["messages"]): ModelRequest => ({ provider: "a", model: "claude-sonnet-5-5", messages, tools: [{ name: "read_file", description: "d", parameters: { type: "object" }, class: "read" }] });
  const run = async (req: ModelRequest, stream: string[]) => {
    let body: Record<string, unknown> = {};
    const fetchFn: FetchLike = async (_url, init) => ((body = JSON.parse(init.body as string)), sseResponse(stream));
    const gw = new Gateway({ fetch: fetchFn });
    gw.register("a", { kind: "anthropic", apiKey: "k" });
    return { events: await collect(gw.stream(req)), body };
  };

  it("turns on automatic caching so each step of a tool loop reads the earlier steps from the cache", async () => {
    const { body } = await run(request([{ role: "system", content: "rules" }, { role: "user", content: "hi" }]), sse({ type: "message_start", message: { usage: { input_tokens: 5 } } }, { type: "message_delta", usage: { output_tokens: 1 } }));
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("gives the stable first system block its own breakpoint when later system blocks change", async () => {
    const { body } = await run(
      request([{ role: "system", content: "stable rules" }, { role: "system", content: "volatile repo map" }, { role: "user", content: "hi" }]),
      sse({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
    );
    expect(body.system).toEqual([
      { type: "text", text: "stable rules", cache_control: { type: "ephemeral" } },
      { type: "text", text: "volatile repo map" },
    ]);
  });

  it("sends no system field when there is no system text", async () => {
    const { body } = await run(request([{ role: "user", content: "hi" }]), sse({ type: "message_start", message: { usage: { input_tokens: 5 } } }));
    expect(body.system).toBeUndefined();
  });

  it("keeps the cached prefix byte-identical between two steps of a run: tools and the stable system text do not change", async () => {
    const sys = { role: "system" as const, content: "stable rules" };
    const a = await run(request([sys, { role: "system", content: "map" }, { role: "user", content: "task" }]), sse({ type: "message_start", message: { usage: {} } }));
    const b = await run(request([sys, { role: "system", content: "map" }, { role: "user", content: "task" }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }]), sse({ type: "message_start", message: { usage: {} } }));
    expect(JSON.stringify(b.body.tools)).toBe(JSON.stringify(a.body.tools));
    expect(JSON.stringify(b.body.system)).toBe(JSON.stringify(a.body.system));
    expect((b.body.messages as unknown[]).slice(0, 1)).toEqual((a.body.messages as unknown[]).slice(0, 1)); // earlier messages are a prefix of later ones
  });

  it("reads cache usage from message_start and reports the WHOLE prompt as inputTokens, with the parts priced separately", async () => {
    const { events } = await run(
      request([{ role: "user", content: "hi" }]),
      sse({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000 } } }, { type: "message_delta", usage: { output_tokens: 500 } }),
    );
    const u = done(events).usage;
    expect(u.inputTokens).toBe(12_100); // so the token meter compares like with like
    expect(u.cacheReadTokens).toBe(10_000);
    expect(u.cacheWriteTokens).toBe(2_000);
    expect(u.outputTokens).toBe(500);
    expect(u.costUsd).toBeCloseTo((100 * 2 + 2_000 * 2 * 1.25 + 10_000 * 2 * 0.05 + 500 * 10) / 1e6, 10);
  });

  it("leaves the cache fields out when nothing was cached", async () => {
    const { events } = await run(request([{ role: "user", content: "hi" }]), sse({ type: "message_start", message: { usage: { input_tokens: 100 } } }, { type: "message_delta", usage: { output_tokens: 5 } }));
    expect(Object.keys(done(events).usage).sort()).toEqual(["costUsd", "inputTokens", "outputTokens"]);
  });
});

describe("OpenAI-compatible cache usage", () => {
  it("reports cached prompt tokens as a subset of the prompt, without changing inputTokens", async () => {
    const fetchFn: FetchLike = async () => sseResponse(sse({ choices: [{ delta: { content: "x" } }] }, { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 2048 } } }));
    const gw = new Gateway({ fetch: fetchFn });
    gw.register("o", { kind: "openai", apiKey: "k" });
    const events = await collect(gw.stream({ provider: "o", model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }));
    expect(done(events).usage).toMatchObject({ inputTokens: 3000, outputTokens: 10, cacheReadTokens: 2048 });
  });
});
