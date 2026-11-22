import { Gateway, type FetchLike } from "@forge/model-gateway";
import { Runtime, type ContextSection } from "@forge/agent-runtime";
import { READ_TOOLS, createToolHost, type FsBackend } from "@forge/tool-host";
import { createIndexTools } from "@forge/indexer";
import { modePrompt } from "@forge/plans";
import { fsApi, indexBackend } from "./ipc";
import type { AgentSettings } from "./settings";
import type { WorkspaceServices } from "./workspace";

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
  services: WorkspaceServices;
  sections: () => Promise<ContextSection[]>;
  audit: (e: AuditEntry) => void;
  onHook?: (event: string, output: string) => void;
}) {
  const { settings } = opts;
  const gateway = new Gateway({
    fetch: await pickFetch(),
    onRequest: (i) => opts.audit({ at: Date.now(), kind: "model-request", name: `${i.provider}/${i.model}`, detail: `${i.url} ${i.local ? "(local)" : "(REMOTE)"}` }),
  });
  gateway.register("default", { kind: settings.provider, baseUrl: settings.baseUrl || undefined, apiKey: settings.apiKey || undefined });
  const tools = createToolHost({
    root: opts.services.root,
    fs: opts.services.overlay(tauriFs),
    tools: [...READ_TOOLS, ...createIndexTools(indexBackend), ...opts.services.editTools, ...opts.services.verifyTools, ...opts.services.planTools],
  });
  const runtime = new Runtime({
    gateway,
    tools,
    provider: "default",
    model: settings.model,
    sections: opts.sections,
    modePrompt,
    gate: opts.services.gate,
    verify: opts.services.verifyDeps,
    hooks: opts.services.hooks,
    limits: { maxSteps: settings.maxSteps, maxCostUsd: settings.maxCostUsd },
    audit: (e) => opts.audit({ at: Date.now(), kind: e.kind, name: e.name, detail: e.detail }),
  });
  opts.services.setRuntime(runtime);
  const started = await runtime.sessionStart().catch(() => null);
  if (started?.type === "hook") opts.onHook?.("SessionStart", started.output);
  return runtime;
}

/** One-shot completion without tools (commit messages, summaries). Returns the streamed text. */
export async function completeOnce(settings: AgentSettings, prompt: string): Promise<string> {
  const gateway = new Gateway({ fetch: await pickFetch() });
  gateway.register("default", { kind: settings.provider, baseUrl: settings.baseUrl || undefined, apiKey: settings.apiKey || undefined });
  let text = "";
  for await (const ev of gateway.stream({ provider: "default", model: settings.model, messages: [{ role: "user", content: prompt }] })) {
    if (ev.type === "text") text += ev.delta;
  }
  return text.trim();
}
