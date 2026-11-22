// Minimal LSP client: JSON-RPC over an abstract transport. No Tauri or Monaco imports, so it is unit-testable.

export interface Transport {
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
}

export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: 1 | 2 | 3 | 4; // error, warning, info, hint
  message: string;
  source?: string;
  code?: string | number;
}

export interface PublishDiagnostics {
  uri: string;
  diagnostics: Diagnostic[];
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private diagnosticsHandlers: ((p: PublishDiagnostics) => void)[] = [];

  constructor(private transport: Transport) {
    transport.onMessage((raw) => this.handle(raw));
  }

  onDiagnostics(handler: (p: PublishDiagnostics) => void) {
    this.diagnosticsHandlers.push(handler);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown) {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async initialize(rootUri: string) {
    const result = await this.request("initialize", {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: { configuration: true },
      },
    });
    this.notify("initialized", {});
    return result;
  }

  openDocument(uri: string, languageId: string, version: number, text: string) {
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
  }

  changeDocument(uri: string, version: number, text: string) {
    this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  closeDocument(uri: string) {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async shutdown() {
    await this.request("shutdown");
    this.notify("exit");
  }

  private handle(raw: string) {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }
    if (msg.method === undefined && typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      for (const h of this.diagnosticsHandlers) h(msg.params as PublishDiagnostics);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // Server-to-client request: answer so the server never stalls.
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const items = (msg.params as { items?: unknown[] })?.items ?? [];
        result = items.map(() => null);
      }
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }
  }
}
