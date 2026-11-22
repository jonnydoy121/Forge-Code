import { Gateway, type FetchLike } from "@forge/model-gateway";
import { Runtime, type ContextSection } from "@forge/agent-runtime";
import { READ_TOOLS, createToolHost, type FsBackend } from "@forge/tool-host";
import { createIndexTools } from "@forge/indexer";
import { fsApi, indexBackend } from "./ipc";
import type { AgentSettings } from "./settings";

export const tauriFs: FsBackend = {
  readFile: fsApi.readFile,
  readdir: async (p) => (await fsApi.listDir(p)).map((e) => ({ name: e.name, isDir: e.is_dir })),
  writeFile: fsApi.writeFile,
};

/** Tauri's HTTP plugin bypasses webview CORS (needed for Ollama and some providers); plain fetch outside Tauri. */
async function pickFetch(): Promise<FetchLike> {
  if ("__TAURI_INTERNALS__" in window) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return (url, init) => fetch(url, init);
  }
  return (url, init) => fetch(url, init);
}

export interface AuditEntry { at: number; kind: string; name: string; detail?: string }

export async function createSession(opts: {
  root: string;
  settings: AgentSettings;
  sections: () => Promise<ContextSection[]>;
  audit: (e: AuditEntry) => void;
}) {
  const { settings } = opts;
  const gateway = new Gateway({
    fetch: await pickFetch(),
    onRequest: (i) => opts.audit({ at: Date.now(), kind: "model-request", name: `${i.provider}/${i.model}`, detail: `${i.url} ${i.local ? "(local)" : "(REMOTE)"}` }),
  });
  gateway.register("default", { kind: settings.provider, baseUrl: settings.baseUrl || undefined, apiKey: settings.apiKey || undefined });
  const tools = createToolHost({ root: opts.root, fs: tauriFs, tools: [...READ_TOOLS, ...createIndexTools(indexBackend)] });
  return new Runtime({
    gateway,
    tools,
    provider: "default",
    model: settings.model,
    sections: opts.sections,
    limits: { maxSteps: settings.maxSteps, maxCostUsd: settings.maxCostUsd },
    audit: (e) => opts.audit({ at: Date.now(), kind: e.kind, name: e.name, detail: e.detail }),
  });
}
