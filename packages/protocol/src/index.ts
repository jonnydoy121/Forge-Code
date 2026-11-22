// Typed contracts between Forge components. See ARCHITECTURE.md.

export type Mode = "ask" | "plan" | "agent" | "debug";
export type ToolClass = "read" | "write" | "execute" | "network";

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ToolResult { id: string; ok: boolean; output: string }

// Model gateway
export interface Message { role: "system" | "user" | "assistant" | "tool"; content: string }
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number; costUsd: number } };
export interface ModelGateway {
  stream(req: { provider: string; model: string; messages: Message[] }): AsyncIterable<StreamEvent>;
}

// Tool host + permission gate
export type PermissionDecision = "allow" | "ask" | "deny";
export interface ToolHost {
  /** Tools exposed to the model for a mode. Ask/Plan MUST omit write and execute tools. */
  listTools(mode: Mode): { name: string; class: ToolClass }[];
  call(mode: Mode, call: ToolCall): Promise<ToolResult>;
}
export interface PermissionGate {
  check(toolClass: ToolClass, call: ToolCall): PermissionDecision;
}

// Checkpoint store
export interface Checkpoint { id: string; step?: number; files: string[]; createdAt: number }
export interface CheckpointStore {
  snapshot(files: string[], meta?: { step?: number }): Promise<Checkpoint>;
  restore(id: string, opts?: { file?: string }): Promise<void>;
  list(): Promise<Checkpoint[]>;
}

// Indexer
export interface SymbolRef { name: string; file: string; line: number; kind: string }
export interface Indexer {
  grep(pattern: string, glob?: string): Promise<{ file: string; line: number; text: string }[]>;
  symbol(name: string): Promise<SymbolRef | undefined>;
  references(symbol: string): Promise<SymbolRef[]>;
  repoMap(focusFiles: string[], tokenBudget: number): Promise<string>;
}

// Context store
export interface Rule { id: string; source: string; text: string; globs?: string[]; activation: "always" | "auto" | "agent" | "manual" }
export interface ContextStore {
  rulesFor(path: string): Promise<Rule[]>;
}

// Hooks (.forge/hooks.json)
export type HookEvent =
  | "PreToolUse" | "PostToolUse" | "PostEdit" | "Stop"
  | "PreCompact" | "PostCompact" | "SessionStart";
export interface HookConfig { event: HookEvent; command: string }

// Agent runtime
export interface AgentRuntime {
  run(req: { mode: Mode; prompt: string }): AsyncIterable<StreamEvent>;
}
