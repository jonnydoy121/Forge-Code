import { lspApi } from "./ipc";
import { LspClient, type Diagnostic } from "./lspClient";
import { pathToUri } from "./uri";

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

  onDiagnostics(h: (uri: string, diags: Diagnostic[]) => void) {
    this.diagHandlers.push(h);
  }
  onStatus(h: (key: ServerKey, s: ServerStatus) => void) {
    this.statusHandlers.push(h);
  }

  async setRoot(root: string | null) {
    await this.stopAll();
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
      client.onDiagnostics((p) => this.diagHandlers.forEach((h) => h(p.uri, p.diagnostics)));
      await client.initialize(pathToUri(root));
      this.statusHandlers.forEach((h) => h(key, { state: "ready" }));
      return { id, client };
    } catch (e) {
      this.statusHandlers.forEach((h) => h(key, { state: "unavailable", detail: String(e) }));
      return null;
    }
  }

  async open(path: string, language: string, version: number, text: string) {
    const s = await this.ensure(language);
    s?.client.openDocument(pathToUri(path), language, version, text);
  }

  async change(path: string, language: string, version: number, text: string) {
    const s = await this.ensure(language);
    s?.client.changeDocument(pathToUri(path), version, text);
  }

  async close(path: string, language: string) {
    const s = await this.ensure(language);
    s?.client.closeDocument(pathToUri(path));
  }
}
