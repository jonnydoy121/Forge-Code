// Typed contracts between Forge components. See ARCHITECTURE.md.

export type Mode = "ask" | "plan" | "agent" | "debug";
/** "plan" = writing the plan file only (allowed in Plan mode). */
export type ToolClass = "read" | "write" | "execute" | "network" | "plan";

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface TouchedFile { path: string; created: boolean; applied: boolean }
export interface ToolResult {
  id: string;
  ok: boolean;
  output: string;
  /** Files a write tool touched, and whether the change reached disk (false = pending review). */
  touched?: TouchedFile[];
}

/** Tool description sent to the model. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  class: ToolClass;
}

// Model gateway
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant messages: tool calls the model made */
  toolCalls?: ToolCall[];
  /** tool messages: which call this answers */
  toolCallId?: string;
}
export interface Usage {
  /** Every token of the prompt, whether it was read from a cache, written to one, or processed normally. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Prompt tokens served from the provider's cache (already included in inputTokens). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache (already included in inputTokens). */
  cacheWriteTokens?: number;
}
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; usage: Usage };
export interface ModelRequest {
  provider: string;
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
}
export interface ModelGateway {
  stream(req: ModelRequest): AsyncIterable<StreamEvent>;
}

// Tool host + permission gate
export type PermissionDecision = "allow" | "ask" | "deny";
export interface ToolHost {
  /** Tools exposed to the model for a mode. Ask/Plan MUST omit write and execute tools. */
  listTools(mode: Mode): ToolSpec[];
  call(mode: Mode, call: ToolCall): Promise<ToolResult>;
}
export interface PermissionGate {
  check(toolClass: ToolClass, call: ToolCall): PermissionDecision | Promise<PermissionDecision>;
}

// Checkpoint store
export interface CheckpointMeta { step?: number; changeSet?: string; label?: string; historyLength?: number }
export interface Checkpoint extends CheckpointMeta { id: string; files: string[]; createdAt: number }
export interface RollbackSelector {
  /** Roll back everything from this checkpoint onward (timeline restore). */
  toCheckpoint?: string;
  changeSet?: string;
  step?: number;
  file?: string;
}
export interface CheckpointStore {
  snapshot(files: string[], meta?: CheckpointMeta): Promise<Checkpoint>;
  restore(id: string, opts?: { file?: string }): Promise<void>;
  rollback(sel: RollbackSelector): Promise<string[]>;
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

// Agent runtime
export type AgentEvent =
  | StreamEvent
  | { type: "tool_result"; result: ToolResult; name: string }
  | { type: "verify"; phase: "fast" | "full"; report: unknown }
  | { type: "hook"; event: HookEvent; output: string; blocked: boolean }
  | { type: "compaction"; summary: string; removedMessages: number; tokensBefore: number; tokensAfter: number }
  | { type: "injection"; tool: string; findings: { pattern: string; excerpt: string }[] }
  | { type: "route"; tier: "scout" | "builder" | "architect"; provider: string; model: string; reason: string }
  | { type: "limit"; reason: "steps" | "cost" | "aborted" | "verify" | "time" };
export interface AgentRuntime {
  run(req: { mode: Mode; prompt: string }): AsyncIterable<AgentEvent>;
}

export * from "./modes";
export * from "./paths";
