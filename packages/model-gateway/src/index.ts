import type { ModelGateway, StreamEvent } from "@forge/protocol";

/** Deterministic gateway for tests; real provider adapters arrive in Phase 2. */
export class EchoGateway implements ModelGateway {
  async *stream(req: { messages: { content: string }[] }): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: req.messages.at(-1)?.content ?? "" };
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}
