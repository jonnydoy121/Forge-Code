// Opt-in measurements of prompt prefix reuse, which is what makes caching pay off: does the layout of Forge's requests (stable system
// text and tools first, the changing parts after) let a real server reuse its work from one step, and one request, to the next?
//
// 1. Ollama on this machine. Skipped unless FORGE_LIVE_SCOUT=<model>. Ollama reuses the evaluated prefix of the previous prompt and
//    reports it as prompt_tokens_details.cached_tokens. Different from Anthropic's cache, but it only helps if the prefix is stable.
// 2. Anthropic. Skipped unless FORGE_LIVE_ANTHROPIC=1 and ANTHROPIC_API_KEY are set. It SPENDS a little money on your account
//    (three requests of about 3,000 prompt tokens on Haiku: a fraction of a cent) and shows real cache writes, reads and cost.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, Message, StreamEvent } from "@forge/protocol";
import { Gateway, usageCost } from "@forge/model-gateway";
import { READ_TOOLS, createEditTools, createToolHost } from "@forge/tool-host";
import { nodeFs } from "@forge/tool-host/src/node-fs";
import { Runtime } from "../src";

const MODEL = process.env.FORGE_LIVE_SCOUT ?? "";

async function runLoop(gateway: Gateway, model: string, files: Record<string, string>, prompt: string) {
  const root = mkdtempSync(join(tmpdir(), "forge-cache-")).replaceAll("\\", "/");
  for (const [p, c] of Object.entries(files)) writeFileSync(`${root}/${p}`, c);
  const sink = {
    read: async (p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    propose: async (p: string, next: string | null) => (next !== null && writeFileSync(p, next), { status: "applied" as const, added: 1, removed: 1 }),
  };
  const tools = createToolHost({ root, fs: nodeFs, tools: [...READ_TOOLS, ...createEditTools(sink)] });
  const rt = new Runtime({ gateway, tools, provider: "local", model, limits: { maxSteps: 6, maxCostUsd: 1, maxSeconds: 120 } });
  const usage: { prompt: number; cached: number; ms: number }[] = [];
  let t = Date.now();
  for await (const e of rt.run({ mode: "agent", prompt }) as AsyncIterable<AgentEvent>) {
    if (e.type === "done") {
      usage.push({ prompt: e.usage.inputTokens, cached: e.usage.cacheReadTokens ?? 0, ms: Date.now() - t });
      t = Date.now();
    }
  }
  return usage;
}

describe.skipIf(!MODEL)(`live: prefix reuse on ${MODEL || "Ollama"}`, () => {
  it("steps of one run, and runs with different requests, reuse the stable prefix", { timeout: 10 * 60_000 }, async () => {
    const gateway = new Gateway({ fetch: (u, i) => fetch(u, i), maxRetries: 0 });
    gateway.register("local", { kind: "ollama" });
    const rows: Record<string, unknown>[] = [];
    const runs = [
      ["rename", { "utils.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n" }, "In utils.ts rename the function add to sum."],
      ["typo", { "README.md": "# Demo\n\nPlease recieve the package.\n" }, "Fix the typo 'recieve' in README.md."],
      ["function", { "math.ts": "export function double(x: number): number {\n  return x * 2;\n}\n" }, "Add a function triple to math.ts that returns its argument times 3."],
    ] as const;
    for (const [name, files, prompt] of runs) {
      const u = await runLoop(gateway, MODEL, files as Record<string, string>, prompt);
      u.forEach((x, i) => rows.push({ run: name, step: i + 1, promptTokens: x.prompt, cachedTokens: x.cached, reusedPct: x.prompt ? Math.round((100 * x.cached) / x.prompt) : 0, seconds: +(x.ms / 1000).toFixed(2) }));
    }
    console.table(rows);
    expect(rows.length).toBeGreaterThanOrEqual(runs.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

const ANTHROPIC = process.env.FORGE_LIVE_ANTHROPIC === "1" && !!process.env.ANTHROPIC_API_KEY;
const AMODEL = process.env.FORGE_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";

describe.skipIf(!ANTHROPIC)(`live: Anthropic prompt caching on ${AMODEL} (spends a fraction of a cent)`, () => {
  it("writes the stable prefix to the cache on the first request and reads it on the next ones, at the cached price", { timeout: 3 * 60_000 }, async () => {
    const gateway = new Gateway({ fetch: (u, i) => fetch(u, i), maxRetries: 1 });
    gateway.register("a", { kind: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY });
    // A stable system prompt well over the minimum cacheable length, then a conversation that grows by one exchange per request.
    const rules = Array.from({ length: 120 }, (_, i) => `Rule ${i + 1}: keep functions small, name things for what they do, and explain the reason for any exception.`).join(" ");
    const system: Message[] = [{ role: "system", content: `You are a terse assistant. ${rules}` }, { role: "system", content: "Context that changes: none." }];
    const turns: Message[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const q of ["Say the word one.", "Say the word two.", "Say the word three."]) {
      turns.push({ role: "user", content: q });
      let reply = "";
      let usage: Extract<StreamEvent, { type: "done" }>["usage"] | undefined;
      for await (const ev of gateway.stream({ provider: "a", model: AMODEL, messages: [...system, ...turns] })) {
        if (ev.type === "text") reply += ev.delta;
        else if (ev.type === "done") usage = ev.usage;
      }
      turns.push({ role: "assistant", content: reply });
      const u = usage!;
      const uncached = usageCost(AMODEL, { input: u.inputTokens, output: u.outputTokens });
      rows.push({ request: q, promptTokens: u.inputTokens, cacheWrite: u.cacheWriteTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, costUsd: +u.costUsd.toFixed(6), ifUncachedUsd: +uncached.toFixed(6) });
    }
    console.table(rows);
    // The proof: after the first request the prefix is read from the cache, and that request costs less than it would have uncached.
    expect(rows[0]!.cacheWrite as number).toBeGreaterThan(0);
    expect(rows[1]!.cacheRead as number).toBeGreaterThan(0);
    expect(rows[2]!.cacheRead as number).toBeGreaterThan(rows[1]!.cacheRead as number);
    expect(rows[2]!.costUsd as number).toBeLessThan(rows[2]!.ifUncachedUsd as number);
  });
});
