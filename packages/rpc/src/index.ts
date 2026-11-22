// Minimal JSON-RPC 2.0 peer over newline-delimited JSON. Used by the MCP and ACP clients.

export interface LineTransport {
  send(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose?(handler: () => void): void;
  close(): void;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcFailure extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = "RpcFailure";
  }
}

export interface PeerHandlers {
  /** Incoming request from the other side. Return the result, or throw (an RpcFailure sets the error code). */
  request?(method: string, params: unknown): Promise<unknown>;
  notification?(method: string, params: unknown): void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> };

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private closed = false;

  constructor(private t: LineTransport, private handlers: PeerHandlers = {}) {
    t.onLine((line) => void this.receive(line));
    t.onClose?.(() => this.failAll(new Error("the connection closed")));
  }

  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      this.t.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.closed) this.t.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  close() {
    this.failAll(new Error("the connection was closed"));
    this.t.close();
  }

  private failAll(err: Error) {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private async receive(line: string) {
    let msg: { id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: RpcError };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON (a server logging to stdout): ignore
    }
    if (msg.method !== undefined) {
      if (msg.id === undefined || msg.id === null) return void this.handlers.notification?.(msg.method, msg.params);
      const id = msg.id;
      try {
        if (!this.handlers.request) throw new RpcFailure(-32601, `method not found: ${msg.method}`);
        const result = await this.handlers.request(msg.method, msg.params);
        this.t.send(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }));
      } catch (e) {
        const err = e instanceof RpcFailure ? { code: e.code, message: e.message, data: e.data } : { code: -32000, message: e instanceof Error ? e.message : String(e) };
        this.t.send(JSON.stringify({ jsonrpc: "2.0", id, error: err }));
      }
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcFailure(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }
}
