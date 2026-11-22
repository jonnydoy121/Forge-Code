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
  storage.setItem(KEY, JSON.stringify(s));
}

/** True when a request with these settings would leave the machine. */
export function sendsCodeOffMachine(s: AgentSettings): boolean {
  const url = s.baseUrl || (s.provider === "ollama" ? "http://127.0.0.1" : "https://remote");
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}
