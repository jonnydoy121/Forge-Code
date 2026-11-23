import { lspApi } from "./ipc";
import { LspClient, type Diagnostic } from "./lspClient";
import { DiagnosticsTracker, type FileCheck, type OpenDoc } from "./diagnosticsTracker";
import { normalizeUri, pathToUri } from "./uri";

export type ServerKey = "typescript" | "python";
export type ServerStatus = { state: "starting" | "ready" | "unavailable"; detail?: string };

export function serverKeyFor(language: string): ServerKey | null {
  if (["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(language)) return "typescript";
  if (language === "python") return "python";
  return null;
}

interface Running {
  id: number;
  client: LspClient;
}

/** Starts one language server per language family, lazily, and fans diagnostics out to the UI. */
export class LspManager {
  private servers = new Map<ServerKey, Promise<Running | null>>();
  private root: string | null = null;
  private diagHandlers: ((uri: string, diags: Diagnostic[]) => void)[] = [];
  private statusHandlers: ((key: ServerKey, s: ServerStatus) => void)[] = [];
  private tracker = new DiagnosticsTracker();
  /** Documents the editor has open, by normalised uri. The editor owns them; the agent's checks never edit them in place. */
  private opened = new Map<string, OpenDoc>();

  onDiagnostics(h: (uri: string, diags: Diagnostic[]) => void) {
    this.diagHandlers.push(h);
  }
  onStatus(h: (key: ServerKey, s: ServerStatus) => void) {
    this.statusHandlers.push(h);
  }

  async setRoot(root: string | null) {
    await this.stopAll();
    this.opened.clear();
    this.root = root;
  }

  async stopAll() {
    const running = await Promise.all([...this.servers.values()]);
    this.servers.clear();
    for (const r of running) if (r) void lspApi.stop(r.id);
  }

  private ensure(language: string): Promise<Running | null> {
    const key = serverKeyFor(language);
    if (!key || !this.root) return Promise.resolve(null);
    let p = this.servers.get(key);
    if (!p) {
      p = this.start(key, language, this.root);
      this.servers.set(key, p);
    }
    return p;
  }

  private async start(key: ServerKey, language: string, root: string): Promise<Running | null> {
    this.statusHandlers.forEach((h) => h(key, { state: "starting" }));
    try {
      const id = await lspApi.start(language, root);
      let handler: (m: string) => void = () => {};
      await lspApi.onMessage((mid, msg) => {
        if (mid === id) handler(msg);
      });
      const client = new LspClient({
        send: (m) => void lspApi.send(id, m),
        onMessage: (h) => (handler = h),
      });
      client.onDiagnostics((p) => {
        if (this.tracker.publish(p.uri, p.diagnostics)) this.diagHandlers.forEach((h) => h(p.uri, p.diagnostics));
      });
      await client.initialize(pathToUri(root));
      this.statusHandlers.forEach((h) => h(key, { state: "ready" }));
      return { id, client };
    } catch (e) {
      this.statusHandlers.forEach((h) => h(key, { state: "unavailable", detail: String(e) }));
      return null;
    }
  }

  async open(path: string, language: string, version: number, text: string) {
    this.opened.set(normalizeUri(pathToUri(path)), { language, version, text });
    const s = await this.ensure(language);
    s?.client.openDocument(pathToUri(path), language, version, text);
  }

  async change(path: string, language: string, version: number, text: string) {
    this.opened.set(normalizeUri(pathToUri(path)), { language, version, text });
    const s = await this.ensure(language);
    s?.client.changeDocument(pathToUri(path), version, text);
  }

  async close(path: string, language: string) {
    this.opened.delete(normalizeUri(pathToUri(path)));
    this.tracker.forget(pathToUri(path));
    const s = await this.ensure(language);
    s?.client.closeDocument(pathToUri(path));
  }

  /** What the language server says about `text` as the file `path` (open in the editor or not), for the agent's `diagnostics` tool. */
  async check(path: string, language: string, text: string): Promise<FileCheck | { status: "no-server"; reason: string; unsupported?: boolean }> {
    if (!serverKeyFor(language)) return { status: "no-server", unsupported: true, reason: `no language server is set up for ${language} files (TypeScript, JavaScript and Python are covered)` };
    const s = await this.ensure(language);
    if (!s) return { status: "no-server", reason: "the language server is not available (not installed, or it failed to start)" };
    const uri = pathToUri(path);
    return this.tracker.check(uri, language, text, s.client, () => this.opened.get(normalizeUri(uri)));
  }
}
