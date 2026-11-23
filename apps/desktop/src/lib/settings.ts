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
  /** ghost-text completions while typing: sends the code around the cursor to the model provider */
  completions: boolean;
  /** model used for completions (a small fast one is best); empty = the agent model */
  completionModel: string;
  /** run the agent loop in its own OS process (falls back to a Web Worker if it cannot start) */
  runtimeProcess: boolean;
  /** embedding server, must be on this machine */
  embedUrl: string;
  /** wall-clock seconds for one agent run */
  maxSeconds: number;
  // Model routing (all optional; with none set every request uses the main model above, the "builder").
  /** scout: a small fast cheap model for chores (summaries, commit messages) and, with triage, simple requests. "" = off */
  scoutProvider: ProviderConfig["kind"] | "";
  scoutModel: string;
  scoutBaseUrl: string;
  /** architect: the strongest model, for plan mode and for fixes the builder could not get right. "" = off */
  architectProvider: ProviderConfig["kind"] | "";
  architectModel: string;
  architectBaseUrl: string;
  /** API keys for a tier on a different provider than the main model. Kept in the OS credential store, never in local storage. */
  scoutApiKey: string;
  architectApiKey: string;
  /** failed check rounds after which the architect takes over (the builder gets the rounds before) */
  escalateAfter: number;
  /** how to size up a request: off, by its wording (free), or by asking the scout model first */
  triage: "off" | "heuristic" | "model";
  /** let the scout take simple requests that need edits, not just questions (needs a model that is good at tool calls) */
  scoutEdits: boolean;
  /** put the instructions of skills that clearly cover the request in front of the model, instead of waiting for it to load them */
  autoSkills: boolean;
  /** most skills applied at once (1 to 3) */
  autoSkillsMax: number;
  /** how strong the match must be: strict, balanced or loose */
  autoSkillsSensitivity: "strict" | "balanced" | "loose";
  /** skills never applied automatically */
  autoSkillsOff: string[];
  /** prices for models the built-in table lacks, one per line: `model input-$ output-$` per million tokens */
  customPrices: string;
}

export const DEFAULT_MODELS: Record<AgentSettings["provider"], string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-4o",
  ollama: "qwen2.5-coder:7b",
};

/** OpenAI-compatible endpoints worth one click. The model is a suggestion to edit; none of these has been run against the live service by this project. */
export const ENDPOINT_PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: "", model: "gpt-4o" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", model: "local-model" },
  { id: "strata", label: "Strata (local)", baseUrl: "http://127.0.0.1:47831/v1", model: "swift-iq2_xs" },
] as const;

/** Which preset a base URL belongs to ("custom" for anything else), so the picker reflects what is saved. */
export function presetFor(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, "");
  return ENDPOINT_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, "") === url)?.id ?? "custom";
}

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
  completions: false,
  completionModel: "",
  runtimeProcess: true,
  embedUrl: "http://127.0.0.1:11434",
  maxSeconds: 1800,
  scoutProvider: "",
  scoutModel: "",
  scoutBaseUrl: "",
  architectProvider: "",
  architectModel: "",
  architectBaseUrl: "",
  scoutApiKey: "",
  architectApiKey: "",
  escalateAfter: 2,
  triage: "off",
  scoutEdits: false,
  autoSkills: true,
  autoSkillsMax: 2,
  autoSkillsSensitivity: "balanced",
  autoSkillsOff: [],
  customPrices: "",
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

export const SETTINGS_EVENT = "forge-settings";

export function saveSettings(s: AgentSettings, storage: StorageLike = localStorage) {
  // The API key is kept in the OS credential store, never in local storage.
  storage.setItem(KEY, JSON.stringify({ ...s, apiKey: "", scoutApiKey: "", architectApiKey: "" }));
  // Tell the rest of the app instead of making it poll for changes.
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SETTINGS_EVENT));
}

/** Run `cb` whenever settings are saved. Returns the unsubscribe function. */
export function onSettingsChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SETTINGS_EVENT, cb);
  return () => window.removeEventListener(SETTINGS_EVENT, cb);
}

/** True when a request with these settings would leave the machine. */
export function sendsCodeOffMachine(s: AgentSettings): boolean {
  const url = s.baseUrl || (s.provider === "ollama" ? "http://127.0.0.1" : "https://remote");
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
}
