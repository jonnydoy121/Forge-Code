import type { ModelGateway, ModelRequest, StreamEvent } from "@forge/protocol";
import { HttpError, anthropicAdapter, openAiCompatibleAdapter, type Adapter, type FetchLike } from "./adapters";

export * from "./adapters";
export * from "./sse";

export interface ProviderConfig {
  kind: "anthropic" | "openai" | "ollama";
  baseUrl?: string;
  apiKey?: string;
}

const DEFAULT_URLS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  ollama: "http://127.0.0.1:11434/v1",
} as const;

export interface GatewayOptions {
  fetch: FetchLike;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called for every outbound model request (audit log, network log). */
  onRequest?: (info: { provider: string; model: string; url: string; local: boolean }) => void;
}

const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u);

export class Gateway implements ModelGateway {
  private adapters = new Map<string, { adapter: Adapter; baseUrl: string }>();
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: GatewayOptions) {
    this.retries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  register(name: string, cfg: ProviderConfig) {
    const baseUrl = (cfg.baseUrl ?? DEFAULT_URLS[cfg.kind]).replace(/\/$/, "");
    const adapter =
      cfg.kind === "anthropic"
        ? anthropicAdapter({ baseUrl, apiKey: cfg.apiKey })
        : openAiCompatibleAdapter({ baseUrl, apiKey: cfg.apiKey }, { free: cfg.kind === "ollama" || isLocalUrl(baseUrl) });
    this.adapters.set(name, { adapter, baseUrl });
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const entry = this.adapters.get(req.provider);
    if (!entry) throw new Error(`unknown provider: ${req.provider}`);
    this.opts.onRequest?.({ provider: req.provider, model: req.model, url: entry.baseUrl, local: isLocalUrl(entry.baseUrl) });
    for (let attempt = 0; ; attempt++) {
      let started = false;
      try {
        for await (const ev of entry.adapter.stream(req, this.opts.fetch)) {
          started = true;
          yield ev;
        }
        return;
      } catch (e) {
        // Retry only if nothing was streamed yet and the failure is transient.
        const refused = typeof e === "object" && e !== null && (e as { retryable?: boolean }).retryable === false;
        const transient = !refused && (e instanceof HttpError ? e.status === 429 || e.status >= 500 : !(e instanceof Error && e.name === "AbortError"));
        if (started || !transient || attempt >= this.retries) throw e;
        await this.sleep(Math.min(8000, 500 * 2 ** attempt));
      }
    }
  }
}

/** Deterministic gateway for tests. */
export class EchoGateway implements ModelGateway {
  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: req.messages.at(-1)?.content ?? "" };
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}

/** Gateway that replays scripted turns; each stream() call consumes one turn. */
export class ScriptedGateway implements ModelGateway {
  public requests: ModelRequest[] = [];
  constructor(private turns: StreamEvent[][]) {}
  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const turn = this.turns.shift() ?? [{ type: "done", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }];
    for (const ev of turn) yield ev;
  }
}
