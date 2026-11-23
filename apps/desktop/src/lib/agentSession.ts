import { Gateway } from "@forge/model-gateway";
import { Runtime, createSubAgentTool, type ContextSection } from "@forge/agent-runtime";
import { READ_TOOLS, createToolHost, type FsBackend } from "@forge/tool-host";
import { createIndexTools } from "@forge/indexer";
import { modePrompt } from "@forge/plans";
import { RuntimeClient, type AgentRuntime } from "@forge/agent-runtime/src/remote";
import { openRuntimePort } from "./runtimeProcess";
import { invoke } from "@tauri-apps/api/core";
import { fsApi, indexBackend } from "./ipc";
import type { AgentSettings } from "./settings";
import type { WorkspaceServices } from "./workspace";

export const tauriFs: FsBackend = {
  readFile: fsApi.readFile,
  readdir: async (p) => (await fsApi.listDir(p)).map((e) => ({ name: e.name, isDir: e.is_dir })),
  writeFile: fsApi.writeFile,
};

/** A gateway whose every request goes through the guarded, logged fetch (local-only mode, network log). */
function makeGateway(services: WorkspaceServices, settings: AgentSettings) {
  const gateway = new Gateway({
    fetch: services.fetch,
    onRequest: (i) => services.audit.record({ kind: "model", name: `${i.provider}/${i.model}`, detail: `${i.url} ${i.local ? "(local)" : "(REMOTE)"}`, local: i.local }),
  });
  gateway.register("default", { kind: settings.provider, baseUrl: settings.baseUrl || undefined, apiKey: settings.apiKey || undefined });
  return gateway;
}

/** The agent loop's transport: its own OS process when the bundled runtime is available, otherwise a Web Worker. */
async function openPort(preferProcess: boolean) {
  if (preferProcess) {
    try {
      const exe = await invoke<string | null>("runtime_sidecar_path");
      if (exe) return { port: await openRuntimePort(exe), kind: "process" as const };
    } catch {
      /* fall through to the worker */
    }
  }
  return { port: new Worker(new URL("./runtime.worker.ts", import.meta.url), { type: "module" }), kind: "worker" as const };
}

export async function createSession(opts: {
  root: string;
  settings: AgentSettings;
  services: WorkspaceServices;
  sections: () => Promise<ContextSection[]>;
  onHook?: (event: string, output: string) => void;
  /** an isolated thread in its own worktree: the workspace-wide code index points at the main checkout, so do not use it */
  isolated?: boolean;
}) {
  const { settings, services } = opts;
  const gateway = makeGateway(services, settings);
  const audit = (kind: "model" | "tool", prefix = "") => (e: { kind: "model" | "tool"; name: string; detail?: string }) =>
    services.audit.record({ kind: e.kind === "model" ? "model" : kind, name: `${prefix}${e.name}`, detail: e.detail });

  const readTools = [...READ_TOOLS, ...(opts.isolated ? [] : createIndexTools(indexBackend)), ...services.contextTools.filter((t) => t.spec.class === "read" && t.spec.name !== "remember")];
  // Sub-agents: fresh context, read-only tools, no `delegate` (no recursion). Only their report comes back.
  const makeSub = () =>
    new Runtime({
      gateway,
      tools: createToolHost({ root: services.root, fs: services.overlay(tauriFs), tools: readTools }),
      provider: "default",
      model: settings.model,
      limits: { maxSteps: 10, maxCostUsd: settings.maxCostUsd, maxSeconds: settings.maxSeconds },
      budgetTokens: settings.budgetTokens,
      audit: audit("tool", "sub-agent "),
    });
  const tools = createToolHost({
    root: services.root,
    fs: services.overlay(tauriFs),
    tools: [
      ...readTools,
      ...services.editTools,
      ...services.verifyTools,
      ...services.planTools,
      ...services.commandTools({ sandbox: settings.sandbox, toolchainRead: settings.toolchainRead }),
      ...services.skillTools({ sandbox: settings.sandbox, toolchainRead: settings.toolchainRead }),
      ...services.mcp.tools(),
      ...services.contextTools.filter((t) => t.spec.name === "remember"),
      createSubAgentTool({ make: makeSub, onCost: (usd) => runtime.addCost(usd) }),
    ],
  });
  const limits = { maxSteps: settings.maxSteps, maxCostUsd: settings.maxCostUsd, maxSeconds: settings.maxSeconds };
  const auditEntry = audit("tool");
  // The agent loop runs outside the UI thread (its own OS process, or a Web Worker as the fallback). Everything that
  // needs Tauri IPC (files, HTTP, permissions, indexing) stays here and is served to it over messages.
  const transport = typeof Worker !== "undefined" ? await openPort(settings.runtimeProcess) : null;
  const runtime: AgentRuntime =
    transport
      ? new RuntimeClient(
          transport.port as never,
          {
            gateway,
            tools,
            gate: services.gate,
            hooks: services.hooks,
            sections: opts.sections,
            modePrompt,
            verify: services.verifyDeps,
            audit: auditEntry,
          },
          { provider: "default", model: settings.model, budgetTokens: settings.budgetTokens, compaction: { threshold: settings.compactionThreshold }, limits },
        )
      : (new Runtime({
          gateway,
          tools,
          provider: "default",
          model: settings.model,
          sections: opts.sections,
          modePrompt,
          gate: services.gate,
          verify: services.verifyDeps,
          hooks: services.hooks,
          budgetTokens: settings.budgetTokens,
          compaction: { threshold: settings.compactionThreshold },
          limits,
          audit: auditEntry,
        }) as unknown as AgentRuntime);
  runtime.transport = transport?.kind ?? "inline";
  services.setRuntime(runtime);
  const started = await runtime.sessionStart().catch(() => null);
  if (started?.type === "hook") opts.onHook?.("SessionStart", started.output);
  return runtime;
}

/** One-shot completion without tools (commit messages, summaries). Returns the streamed text. */
export async function completeOnce(settings: AgentSettings, services: WorkspaceServices, prompt: string): Promise<string> {
  const gateway = makeGateway(services, settings);
  let text = "";
  for await (const ev of gateway.stream({ provider: "default", model: settings.model, messages: [{ role: "user", content: prompt }] })) {
    if (ev.type === "text") text += ev.delta;
  }
  return text.trim();
}

/** Short, cancellable completion for ghost text: stops reading as soon as it has `maxChars`, or when aborted. */
export async function completeShort(settings: AgentSettings, services: WorkspaceServices, prompt: string, signal: AbortSignal, maxChars = 900): Promise<string> {
  const gateway = makeGateway(services, settings);
  let text = "";
  for await (const ev of gateway.stream({ provider: "default", model: settings.completionModel.trim() || settings.model, messages: [{ role: "user", content: prompt }], signal })) {
    if (signal.aborted) break;
    if (ev.type === "text") {
      text += ev.delta;
      if (text.length >= maxChars) break;
    }
  }
  return text;
}
