// Newline-delimited JSON framing so the worker protocol (remote.ts) can run across a process boundary. Both sides see
// the same `Port` surface they use with a Web Worker; only the transport changes.
//
// One process serves every agent thread: each line carries a session id, `{"s": "<id>", "m": <message>}`, and
// `{"s": "<id>", "end": true}` closes a session. That is one process (about 33 MB) instead of one per thread.

import { serveRuntime, type Port } from "./remote";

type Subscribe = (onLine: (line: string) => void) => void;

/** Split arbitrary stream chunks into lines. */
export function lineSplitter(onLine: (line: string) => void) {
  let buf = "";
  return (chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
  };
}

/** The host side: many sessions, each with its own Port, over one connection to the runtime process. */
export class MuxClient {
  private ports = new Map<string, Port>();
  /** Called when the last session closes, so the owner can release the process. */
  onEmpty: (() => void) | null = null;

  constructor(
    private write: (line: string) => void,
    subscribe: Subscribe,
  ) {
    subscribe((line) => {
      if (!line.trim()) return;
      try {
        const f = JSON.parse(line) as { s?: string; m?: unknown };
        if (f.s) this.ports.get(f.s)?.onmessage?.({ data: f.m });
      } catch {
        /* stray non-protocol output */
      }
    });
  }

  get size() {
    return this.ports.size;
  }

  open(id: string): Port {
    const port: Port = {
      onmessage: null,
      onclose: null,
      postMessage: (m) => this.write(JSON.stringify({ s: id, m })),
      close: () => {
        if (!this.ports.delete(id)) return;
        this.write(JSON.stringify({ s: id, end: true }));
        if (this.ports.size === 0) this.onEmpty?.();
      },
    };
    this.ports.set(id, port);
    return port;
  }

  /** The connection died (the process exited): tell every open session so pending work fails instead of hanging. */
  disconnected() {
    const all = [...this.ports.values()];
    this.ports.clear();
    for (const p of all) p.onclose?.();
  }
}

/** The runtime-process side: creates a runtime the first time a session id appears, and tears it down on `end`. */
export function serveMux(write: (line: string) => void, subscribe: Subscribe) {
  const sessions = new Map<string, { port: Port; dispose: () => void }>();
  subscribe((line) => {
    if (!line.trim()) return;
    let f: { s?: string; m?: unknown; end?: boolean };
    try {
      f = JSON.parse(line);
    } catch {
      return; // stray non-protocol output
    }
    const id = f.s;
    if (!id) return;
    if (f.end) {
      sessions.get(id)?.dispose();
      sessions.delete(id);
      return;
    }
    let session = sessions.get(id);
    if (!session) {
      const port: Port = { onmessage: null, postMessage: (m) => write(JSON.stringify({ s: id, m })) };
      session = { port, dispose: serveRuntime(port) };
      sessions.set(id, session);
    }
    session.port.onmessage?.({ data: f.m });
  });
  return { sessions: () => sessions.size };
}
