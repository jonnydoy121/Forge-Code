import type { ProviderConfig } from "@forge/model-gateway";
import type { ReviewMode } from "@forge/review";

export interface AgentSettings {
  provider: ProviderConfig["kind"];
  model: string;
  baseUrl: string;
  apiKey: string;
  maxSteps: number;
  maxCostUsd: number;
  reviewMode: ReviewMode;
  /** personal rules applied to every project (lowest precedence) */
  userRules: string;
  /** let the agent create memories itself (always shown to you); off by default */
  autoMemories: boolean;
  /** token budget for assembled context */
  budgetTokens: number;
  /** compact older turns when the context reaches this fraction of the budget */
  compactionThreshold: number;
  /** block every request that would leave this machine (models, docs, web pages) */
  localOnly: boolean;
  /** run agent commands in the OS sandbox: workspace only, no network, scrubbed environment */
  sandbox: boolean;
  /** let the sandbox read tool directories on PATH (node, git, ...) so project tools run */
  toolchainRead: boolean;
  /** local embedding model (Ollama), e.g. nomic-embed-text; empty = the built-in lexical embedder */
  embedModel: string;
  /** embedding server, must be on this machine */
  embedUrl: string;
  /** wall-clock seconds for one agent run */
  maxSeconds: number;
}

export const DEFAULT_MODELS: Record<AgentSettings["provider"], string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-4o",
  ollama: "qwen2.5-coder:7b",
};

export const DEFAULT_SETTINGS: AgentSettings = {
  provider: "ollama", // local-first: nothing leaves the machine until the user picks a hosted provider
  model: DEFAULT_MODELS.ollama,
  baseUrl: "",
  apiKey: "",
  maxSteps: 12,
  maxCostUsd: 2,
  reviewMode: "review",
  userRules: "",
  autoMemories: false,
  budgetTokens: 100_000,
  compactionThreshold: 0.8,
  localOnly: false,
  sandbox: true,
  toolchainRead: true,
  embedModel: "",
  embedUrl: "http://127.0.0.1:11434",
  maxSeconds: 1800,
};

const KEY = "forge.settings.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadSettings(storage: StorageLike = localStorage): AgentSettings {
  try {
    const raw = storage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AgentSettings>) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AgentSettings, storage: StorageLike = localStorage) {
  // The API key is kept in the OS credential store, never in local storage.
  storage.setItem(KEY, JSON.stringify({ ...s, apiKey: "" }));
}

/** True when a request with these settings would leave the machine. */
export function sendsCodeOffMachine(s: AgentSettings): boolean {
  const url = s.baseUrl || (s.provider === "ollama" ? "http://127.0.0.1" : "https://remote");
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}
