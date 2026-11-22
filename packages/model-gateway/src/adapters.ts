import type { Message, ModelRequest, StreamEvent, ToolCall, ToolSpec, Usage } from "@forge/protocol";
import { parseSse } from "./sse";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Adapter {
  stream(req: ModelRequest, fetchFn: FetchLike): AsyncIterable<StreamEvent>;
}

export interface AdapterConfig {
  baseUrl: string;
  apiKey?: string;
}

/** USD per million tokens [input, output]. Local models are free. */
export const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [3, 15],
  "claude-opus-5-5": [15, 75],
  "claude-haiku-5-5": [1, 5],
};

export function costFor(model: string, input: number, output: number): number {
  const p = PRICES[model];
  return p ? (input * p[0] + output * p[1]) / 1_000_000 : 0;
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
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
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
          system: system || undefined,
          messages: toAnthropicMessages(req.messages),
          tools: req.tools?.length ? anthropicTools(req.tools) : undefined,
        }),
      });
      if (!res.ok) throw new HttpError(res.status, await res.text());
      const blocks = new Map<number, { id: string; name: string; json: string }>();
      let input = 0;
      let output = 0;
      for await (const ev of parseSse(res.body!)) {
        const d = safeJson(ev.data) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        switch (d.type) {
          case "message_start":
            input = d.message?.usage?.input_tokens ?? 0;
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
            break;
          case "error":
            throw new Error(`Anthropic stream error: ${d.error?.message ?? "unknown"}`);
        }
      }
      const usage: Usage = { inputTokens: input, outputTokens: output, costUsd: costFor(req.model, input, output) };
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
      let input = 0;
      let output = 0;
      for await (const ev of parseSse(res.body!)) {
        if (ev.data === "[DONE]") break;
        const d = safeJson(ev.data) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (d.usage) {
          input = d.usage.prompt_tokens ?? input;
          output = d.usage.completion_tokens ?? output;
        }
        const delta = d.choices?.[0]?.delta;
        if (delta?.content) yield { type: "text", delta: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
      }
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: "tool_call", call: { id: c.id || `call_${c.name}`, name: c.name, args: safeJson(c.args) } };
      }
      yield { type: "done", usage: { inputTokens: input, outputTokens: output, costUsd: opts.free ? 0 : costFor(req.model, input, output) } };
    },
  };
}
