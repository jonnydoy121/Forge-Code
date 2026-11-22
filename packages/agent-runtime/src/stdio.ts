// Newline-delimited JSON framing so the worker protocol (remote.ts) can run across a process boundary. Both sides see
// the same `Port` surface they use with a Web Worker; only the transport changes.

import type { Port } from "./remote";

/** A Port over line I/O: `write` sends one line, `subscribe` delivers incoming lines. */
export function linePort(write: (line: string) => void, subscribe: (onLine: (line: string) => void) => void, onClose: () => void = () => {}): Port {
  const port: Port = {
    onmessage: null,
    postMessage: (m) => write(JSON.stringify(m)),
    close: onClose,
  };
  subscribe((line) => {
    if (!line.trim()) return;
    try {
      port.onmessage?.({ data: JSON.parse(line) });
    } catch {
      /* a garbled line (stray log output) is ignored rather than killing the session */
    }
  });
  return port;
}

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
