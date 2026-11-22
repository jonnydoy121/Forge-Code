// Agent Client Protocol client. Forge is the *client*: it starts an external agent (Claude Code, Gemini CLI, Codex,
// ...) as a subprocess and speaks JSON-RPC over stdio. The agent reads and writes files THROUGH Forge, so its edits
// land in the same pending-changes model and review UI as the built-in agent's.

import { isIgnoredDir, isSecretPath, resolveInRoot } from "@forge/protocol";
import { JsonRpcPeer, RpcFailure, type LineTransport } from "@forge/rpc";

export const ACP_PROTOCOL_VERSION = 1;

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface ToolCallInfo {
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
}

export type AcpUpdate =
  | { kind: "message"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; id: string; title: string; toolKind?: string; status: string }
  | { kind: "tool_call_update"; id: string; status?: string; text?: string }
  | { kind: "plan"; entries: { content: string; status: string }[] }
  | { kind: "other"; raw: unknown };

export interface AcpHandlers {
  readTextFile(path: string, line?: number, limit?: number): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  requestPermission(req: { toolCall: ToolCallInfo; options: PermissionOption[] }): Promise<{ optionId: string } | "cancelled">;
  onUpdate(update: AcpUpdate): void;
}

interface RawUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string } | { type?: string; text?: string }[];
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  entries?: { content: string; status: string }[];
}

const textOf = (c: RawUpdate["content"]): string => (Array.isArray(c) ? c.map((x) => x.text ?? "").join("") : (c?.text ?? ""));

export function toUpdate(raw: RawUpdate): AcpUpdate {
  switch (raw.sessionUpdate) {
    case "agent_message_chunk":
      return { kind: "message", text: textOf(raw.content) };
    case "agent_thought_chunk":
      return { kind: "thought", text: textOf(raw.content) };
    case "tool_call":
      return { kind: "tool_call", id: raw.toolCallId ?? "", title: raw.title ?? "tool call", toolKind: raw.kind, status: raw.status ?? "pending" };
    case "tool_call_update":
      return { kind: "tool_call_update", id: raw.toolCallId ?? "", status: raw.status, text: raw.content ? textOf(raw.content) : undefined };
    case "plan":
      return { kind: "plan", entries: raw.entries ?? [] };
    default:
      return { kind: "other", raw };
  }
}

export class AcpClient {
  private peer: JsonRpcPeer;
  agentInfo: { name?: string; version?: string } = {};

  constructor(transport: LineTransport, private handlers: AcpHandlers) {
    this.peer = new JsonRpcPeer(transport, {
      request: (method, params) => this.onRequest(method, params as Record<string, unknown>),
      notification: (method, params) => {
        if (method === "session/update") handlers.onUpdate(toUpdate(((params as { update?: RawUpdate })?.update ?? {}) as RawUpdate));
      },
    });
  }

  private async onRequest(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "fs/read_text_file":
        return { content: await this.handlers.readTextFile(String(p.path), typeof p.line === "number" ? p.line : undefined, typeof p.limit === "number" ? p.limit : undefined) };
      case "fs/write_text_file":
        await this.handlers.writeTextFile(String(p.path), String(p.content ?? ""));
        return null;
      case "session/request_permission": {
        const r = await this.handlers.requestPermission({ toolCall: (p.toolCall ?? {}) as ToolCallInfo, options: (p.options ?? []) as PermissionOption[] });
        return r === "cancelled" ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: r.optionId } };
      }
      default:
        // terminal/* and anything else: Forge does not offer it (the capability is not advertised).
        throw new RpcFailure(-32601, `method not supported by this client: ${method}`);
    }
  }

  async initialize(): Promise<{ protocolVersion: number; authMethods: unknown[] }> {
    const r = await this.peer.request<{ protocolVersion: number; agentInfo?: { name?: string; version?: string }; authMethods?: unknown[] }>(
      "initialize",
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "forge", version: "0.0.0" } },
      { timeoutMs: 60_000 },
    );
    this.agentInfo = r.agentInfo ?? {};
    return { protocolVersion: r.protocolVersion, authMethods: r.authMethods ?? [] };
  }

  async newSession(cwd: string): Promise<string> {
    return (await this.peer.request<{ sessionId: string }>("session/new", { cwd, mcpServers: [] }, { timeoutMs: 60_000 })).sessionId;
  }

  /** Send a prompt; resolves with the stop reason when the agent's turn ends. Updates stream in via the handler. */
  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    return this.peer.request<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  cancel(sessionId: string) {
    this.peer.notify("session/cancel", { sessionId });
  }

  close() {
    this.peer.close();
  }
}

// ---------- Forge's side of the file and permission methods ----------

export interface ForgeAcpDeps {
  /** workspace root, forward slashes */
  root: string;
  /** Current content a reader should see: the pending proposal if there is one, else disk. null = missing. */
  read(path: string): Promise<string | null>;
  /** Hand an edit to the pending-changes model (the review UI). */
  propose(path: string, content: string, reason: string): Promise<{ status: string }>;
  /** Ask the developer. `danger` is set for deny-listed commands. */
  ask(req: { title: string; summary: string; danger?: string }): Promise<"once" | "session" | "always" | "deny">;
  onUpdate(u: AcpUpdate): void;
  /** classify a shell command from a tool call's raw input (deny list); returns a reason or null */
  denyReason?(command: string): string | null;
  agentName?: string;
  audit?(e: { kind: "external"; name: string; detail?: string; blocked?: boolean }): void;
}

export function forgeAcpHandlers(d: ForgeAcpDeps): AcpHandlers {
  const agent = d.agentName ?? "external agent";
  const confine = (raw: string, forWrite: boolean) => {
    const path = resolveInRoot(d.root, raw); // throws if it escapes the workspace
    if (isSecretPath(path)) throw new Error("refusing: this file looks like it holds secrets");
    if (forWrite && path.split("/").some((c) => isIgnoredDir(c))) throw new Error("refusing: writes to ignored or generated directories are not allowed");
    return path;
  };
  return {
    async readTextFile(raw, line, limit) {
      let path: string;
      try {
        path = confine(raw, false);
      } catch (e) {
        d.audit?.({ kind: "external", name: `${agent} read ${raw}`, detail: String(e instanceof Error ? e.message : e), blocked: true });
        throw e;
      }
      const text = await d.read(path);
      if (text === null) throw new Error(`file not found: ${raw}`);
      d.audit?.({ kind: "external", name: `${agent} read ${raw}` });
      if (line === undefined && limit === undefined) return text;
      const lines = text.split("\n");
      const start = Math.max(1, line ?? 1) - 1;
      return lines.slice(start, limit ? start + limit : undefined).join("\n");
    },
    async writeTextFile(raw, content) {
      let path: string;
      try {
        path = confine(raw, true);
      } catch (e) {
        d.audit?.({ kind: "external", name: `${agent} write ${raw}`, detail: String(e instanceof Error ? e.message : e), blocked: true });
        throw e;
      }
      const out = await d.propose(path, content, `Edit by ${agent}`);
      d.audit?.({ kind: "external", name: `${agent} write ${raw}`, detail: out.status });
    },
    async requestPermission({ toolCall, options }) {
      const title = toolCall.title ?? toolCall.kind ?? "an action";
      const input = toolCall.rawInput as { command?: unknown } | undefined;
      const command = typeof input?.command === "string" ? input.command : undefined;
      const danger = (command && d.denyReason?.(command)) || undefined;
      const answer = await d.ask({ title: `${agent}: ${title}`, summary: command ? `${agent} wants to run: ${command}` : `${agent} wants to: ${title}`, danger });
      d.audit?.({ kind: "external", name: `${agent} permission: ${title}`, detail: answer, blocked: answer === "deny" });
      const pick = (...kinds: PermissionOption["kind"][]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
      const chosen = answer === "deny" ? pick("reject_once", "reject_always") : answer === "once" || danger ? pick("allow_once", "allow_always") : pick("allow_always", "allow_once");
      return chosen ? { optionId: chosen.optionId } : "cancelled";
    },
    onUpdate: d.onUpdate,
  };
}

export interface AcpAgentConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Parse .forge/acp.json: `{"agents": {"gemini": {"command": "gemini", "args": ["--experimental-acp"]}}}`. */
export function parseAcpConfig(text: string | null): { agents: AcpAgentConfig[]; errors: string[] } {
  const errors: string[] = [];
  if (!text) return { agents: [], errors };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { agents: [], errors: [`.forge/acp.json is not valid JSON: ${(e as Error).message}`] };
  }
  const agents: AcpAgentConfig[] = [];
  for (const [name, v] of Object.entries(((raw ?? {}) as { agents?: Record<string, unknown> }).agents ?? {})) {
    const c = v as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof c?.command !== "string" || !c.command.trim()) {
      errors.push(`agent "${name}" needs a "command"`);
      continue;
    }
    agents.push({
      name,
      command: c.command,
      args: Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === "string") : [],
      env: c.env && typeof c.env === "object" ? (Object.fromEntries(Object.entries(c.env as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>) : {},
    });
  }
  return { agents, errors };
}
