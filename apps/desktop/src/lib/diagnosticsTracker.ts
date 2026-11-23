// Keeps the latest LSP diagnostics per file and answers "what does the language server say about this text?" for the agent,
// including for files the editor has not opened. No Tauri or Monaco imports, so it is unit-testable with a fake client.
import type { Diagnostic } from "./lspClient";
import { normalizeUri } from "./uri";

/** The slice of the LSP client the tracker drives. */
export interface DocClient {
  openDocument(uri: string, language: string, version: number, text: string): void;
  closeDocument(uri: string): void;
}

/** A document the editor has open (and so owns: its version numbers must only go up). */
export interface OpenDoc {
  language: string;
  version: number;
  text: string;
}

export type FileCheck = { status: "ok"; diagnostics: Diagnostic[] } | { status: "timeout" };

export class DiagnosticsTracker {
  private latest = new Map<string, Diagnostic[]>();
  private listeners = new Map<string, Set<(d: Diagnostic[]) => void>>();
  /** Probe documents currently open on the server, and every probe uri ever used (their diagnostics are never the editor's business). */
  private probing = new Set<string>();
  private shadows = new Set<string>();
  /** Files whose text changed in the editor and that the server has not published for since: the cached diagnostics describe older text. */
  private dirty = new Set<string>();
  private queue = new Map<string, Promise<unknown>>();

  /** `timeoutMs`: give up waiting for the server. `settleMs`: servers publish in several rounds, so wait for quiet before answering. */
  constructor(private timeoutMs = 15_000, private settleMs = 250) {}

  /** Record a `publishDiagnostics`. Returns whether the editor should show it (not while the agent is probing that file). */
  publish(uri: string, diagnostics: Diagnostic[]): boolean {
    const key = normalizeUri(uri);
    if (this.shadows.has(key)) {
      if (this.probing.has(key)) this.listeners.get(key)?.forEach((l) => l(diagnostics));
      return false;
    }
    this.latest.set(key, diagnostics);
    this.dirty.delete(key); // the server has spoken since the last change
    this.listeners.get(key)?.forEach((l) => l(diagnostics));
    return true;
  }

  /** The editor closed the file: what we knew about it is no longer current. */
  forget(uri: string) {
    const key = normalizeUri(uri);
    this.latest.delete(key);
    this.dirty.delete(key);
  }

  /** The editor changed this file's text: what we have cached for it is out of date until the server publishes again. */
  markDirty(uri: string) {
    const key = normalizeUri(uri);
    this.latest.delete(key);
    this.dirty.add(key);
  }

  /** Forget everything cached (the workspace changed, so the servers did). */
  reset() {
    this.latest.clear();
    this.dirty.clear();
  }

  /** Resolves with the last diagnostics once the server has been quiet for `settleMs`, or null if it never published. */
  private wait(key: string): Promise<Diagnostic[] | null> {
    return new Promise((resolve) => {
      let last: Diagnostic[] | null = null;
      let settle: ReturnType<typeof setTimeout> | undefined;
      const done = (v: Diagnostic[] | null) => {
        clearTimeout(settle);
        clearTimeout(hard);
        this.listeners.get(key)?.delete(listener);
        resolve(v);
      };
      const listener = (d: Diagnostic[]) => {
        last = d;
        clearTimeout(settle);
        settle = setTimeout(() => done(last), this.settleMs);
      };
      const hard = setTimeout(() => done(last), this.timeoutMs);
      if (!this.listeners.has(key)) this.listeners.set(key, new Set());
      this.listeners.get(key)!.add(listener);
    });
  }

  /**
   * Diagnostics for `text` as the file `uri`. `current()` says what the editor has open for that file right now.
   * - The editor has exactly this text open: the live diagnostics it already receives.
   * - Anything else (a file the editor does not have, or the agent's unaccepted edit of one it does): the text is opened on the
   *   server under a sibling "shadow" uri (`a.ts` -> `a.forge-check.ts`), so the real document, its version numbers and its
   *   diagnostics are never touched, and a tsconfig `include` still covers it. The editor never sees the shadow's diagnostics.
   * Checks of the same file run one at a time.
   */
  check(uri: string, language: string, text: string, client: DocClient, current: () => OpenDoc | undefined): Promise<FileCheck> {
    const key = normalizeUri(uri);
    const run = (this.queue.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.run(key, uri, language, text, client, current));
    this.queue.set(key, run);
    return run.finally(() => {
      if (this.queue.get(key) === run) this.queue.delete(key);
    });
  }

  private async run(key: string, uri: string, language: string, text: string, client: DocClient, current: () => OpenDoc | undefined): Promise<FileCheck> {
    const open = current();
    // Served from the live diagnostics only when they describe this text: a change the server has not answered yet is probed instead.
    if (open && open.text === text && !this.dirty.has(key)) {
      const cached = this.latest.get(key);
      if (cached) return { status: "ok", diagnostics: cached };
      const d = await this.wait(key);
      return d ? { status: "ok", diagnostics: d } : { status: "timeout" };
    }
    const probe = shadowUri(uri);
    const probeKey = normalizeUri(probe);
    this.shadows.add(probeKey);
    this.probing.add(probeKey);
    try {
      const waiting = this.wait(probeKey); // listen before opening so the first publish cannot be missed
      client.openDocument(probe, language, 1, text);
      const d = await waiting;
      return d ? { status: "ok", diagnostics: d } : { status: "timeout" };
    } finally {
      this.probing.delete(probeKey);
      client.closeDocument(probe);
    }
  }
}

/** `file:///ws/src/a.ts` -> `file:///ws/src/a.forge-check.ts` (same folder, so relative imports and tsconfig globs behave the same). */
export function shadowUri(uri: string): string {
  const slash = uri.lastIndexOf("/");
  const name = uri.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return uri.slice(0, slash + 1) + (dot > 0 ? `${name.slice(0, dot)}.forge-check${name.slice(dot)}` : `${name}.forge-check`);
}
