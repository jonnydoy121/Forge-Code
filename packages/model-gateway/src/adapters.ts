import type { Message, ModelRequest, StreamEvent, ToolCall, ToolSpec, Usage } from "@forge/protocol";
import { parseSse } from "./sse";
import { mayBeTextToolCall, recoverToolCalls } from "./text-tool-calls";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Adapter {
  stream(req: ModelRequest, fetchFn: FetchLike): AsyncIterable<StreamEvent>;
}

export interface AdapterConfig {
  baseUrl: string;
  apiKey?: string;
  /** Prices the user gave for models the built-in table does not know. Read on every request, so later changes apply. */
  prices?: Record<string, Price>;
}

/** One model's price in USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  /** A cache hit costs this multiple of `input`. */
  cacheRead: number;
  /** Above this many prompt tokens (input + cache reads and writes) the model is billed at the `long` rates. */
  long?: { over: number; input: number; output: number };
}

/**
 * Prices from Anthropic's prompt-caching docs (https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching, read
 * 2026-11-23). A cache write (5 minute lifetime) costs 1.25x the input price. Local models and models not listed are
 * free here: their cost is not tracked, so the Max $ limit does not see them.
 */
export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.025 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.05 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.1, long: { over: 100_000, input: 0.5, output: 2.5 } },
};

export const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenCounts {
  /** Prompt tokens processed normally (not read from or written to a cache). */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The price of a model: the user's own, else the built-in table; undefined when neither knows it. */
export function priceOf(model: string, custom?: Record<string, Price>): Price | undefined {
  return custom?.[model] ?? PRICES[model];
}

export function usageCost(model: string, t: TokenCounts, custom?: Record<string, Price>): number {
  const p = priceOf(model, custom);
  if (!p) return 0;
  const read = t.cacheRead ?? 0;
  const write = t.cacheWrite ?? 0;
  const rates = p.long && t.input + read + write > p.long.over ? { input: p.long.input, output: p.long.output } : p;
  return (t.input * rates.input + write * rates.input * CACHE_WRITE_MULTIPLIER + read * rates.input * p.cacheRead + t.output * rates.output) / 1_000_000;
}

/** Cost of a request with no caching involved. */
export function costFor(model: string, input: number, output: number, custom?: Record<string, Price>): number {
  return usageCost(model, { input, output }, custom);
}

export class HttpError extends Error {
  constructor(public status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------- Anthropic ----------

function toAnthropicMessages(messages: Message[]) {
  const out: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

const anthropicTools = (tools: ToolSpec[]) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

export function anthropicAdapter(cfg: AdapterConfig): Adapter {
  return {
    async *stream(req, fetchFn) {
      // One text block per system message. With several, the first is the stable part (rules, mode) and gets its own cache
      // breakpoint, so it stays cached even when the later, changing parts (repo map, attachments) do not.
      const systemMessages = req.messages.filter((m) => m.role === "system" && m.content);
      const system = systemMessages.map((m, i) => ({ type: "text", text: m.content, ...(systemMessages.length > 1 && i === 0 ? { cache_control: { type: "ephemeral" } } : {}) }));
      const res = await fetchFn(`${cfg.baseUrl}/v1/messages`, {
        method: "POST",
        signal: req.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: 8192,
          stream: true,
          // Automatic caching: the breakpoint follows the end of the conversation, so each step of a tool loop reads the earlier
          // steps from the cache instead of paying for them again. Prefixes shorter than the model's minimum are simply not cached.
          cache_control: { type: "ephemeral" },
          system: system.length ? system : undefined,
          messages: toAnthropicMessages(req.messages),
          tools: req.tools?.length ? anthropicTools(req.tools) : undefined,
        }),
      });
      if (!res.ok) throw new HttpError(res.status, await res.text());
      const blocks = new Map<number, { id: string; name: string; json: string }>();
      let input = 0; // prompt tokens after the last cache breakpoint (the API excludes cached ones from input_tokens)
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      for await (const ev of parseSse(res.body!)) {
        const d = safeJson(ev.data) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        switch (d.type) {
          case "message_start":
            input = d.message?.usage?.input_tokens ?? 0;
            cacheRead = d.message?.usage?.cache_read_input_tokens ?? 0;
            cacheWrite = d.message?.usage?.cache_creation_input_tokens ?? 0;
            break;
          case "content_block_start":
            if (d.content_block?.type === "tool_use") blocks.set(d.index, { id: d.content_block.id, name: d.content_block.name, json: "" });
            break;
          case "content_block_delta":
            if (d.delta?.type === "text_delta") yield { type: "text", delta: d.delta.text };
            else if (d.delta?.type === "input_json_delta") {
              const b = blocks.get(d.index);
              if (b) b.json += d.delta.partial_json;
            }
            break;
          case "content_block_stop": {
            const b = blocks.get(d.index);
            if (b) {
              blocks.delete(d.index);
              yield { type: "tool_call", call: { id: b.id, name: b.name, args: safeJson(b.json) } };
            }
            break;
          }
          case "message_delta":
            output = d.usage?.output_tokens ?? output;
            input = d.usage?.input_tokens ?? input;
            cacheRead = d.usage?.cache_read_input_tokens ?? cacheRead;
            cacheWrite = d.usage?.cache_creation_input_tokens ?? cacheWrite;
            break;
          case "error":
            throw new Error(`Anthropic stream error: ${d.error?.message ?? "unknown"}`);
        }
      }
      // inputTokens is the whole prompt (the token meter compares it with its own estimate); the parts are kept for the cost.
      const usage: Usage = {
        inputTokens: input + cacheRead + cacheWrite,
        outputTokens: output,
        costUsd: usageCost(req.model, { input, output, cacheRead, cacheWrite }, cfg.prices),
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      };
      yield { type: "done", usage };
    },
  };
}

// ---------- OpenAI-compatible (OpenAI, Ollama /v1, OpenRouter, ...) ----------

function toOpenAiMessages(messages: Message[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c: ToolCall) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function openAiCompatibleAdapter(cfg: AdapterConfig, opts: { free?: boolean } = {}): Adapter {
  return {
    async *stream(req, fetchFn) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        signal: req.signal,
        headers,
        body: JSON.stringify({
          model: req.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: toOpenAiMessages(req.messages),
          tools: req.tools?.length
            ? req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
            : undefined,
        }),
      });
      if (!res.ok) throw new HttpError(res.status, await res.text());
      const calls = new Map<number, { id: string; name: string; args: string }>();
      // Text that may turn out to be a tool call written as text (some local models do that) is held back until the end; any
      // other text streams straight through.
      const toolNames = (req.tools ?? []).map((t) => t.name);
      let held = "";
      let holding: boolean | undefined = toolNames.length ? undefined : false;
      let input = 0;
      let output = 0;
      let cached = 0;
      for await (const ev of parseSse(res.body!)) {
        if (ev.data === "[DONE]") break;
        const d = safeJson(ev.data) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (d.usage) {
          input = d.usage.prompt_tokens ?? input;
          output = d.usage.completion_tokens ?? output;
          cached = d.usage.prompt_tokens_details?.cached_tokens ?? cached; // a subset of prompt_tokens; the provider caches prefixes by itself
        }
        const delta = d.choices?.[0]?.delta;
        if (delta?.content) {
          if (holding === false) yield { type: "text", delta: delta.content };
          else {
            held += delta.content;
            holding = mayBeTextToolCall(held);
            if (holding === false) {
              yield { type: "text", delta: held };
              held = "";
            }
          }
        }
        for (const tc of delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
      }
      if (held) {
        const recovered = calls.size === 0 ? recoverToolCalls(held, toolNames) : null;
        if (recovered) for (const call of recovered) yield { type: "tool_call", call };
        else yield { type: "text", delta: held };
      }
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: "tool_call", call: { id: c.id || `call_${c.name}`, name: c.name, args: safeJson(c.args) } };
      }
      yield { type: "done", usage: { inputTokens: input, outputTokens: output, costUsd: opts.free ? 0 : usageCost(req.model, { input: Math.max(0, input - cached), output, cacheRead: cached }, cfg.prices), ...(cached > 0 ? { cacheReadTokens: cached } : {}) } };
    },
  };
}
