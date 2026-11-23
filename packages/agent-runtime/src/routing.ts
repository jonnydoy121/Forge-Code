// Model routing: which model answers which request. Three tiers, all optional.
//   scout     small, fast, cheap (Haiku, Flash, a local Qwen): chores such as summarising older turns, and simple requests
//   builder   the everyday model: the session's main model, and the fallback for any tier that is not set
//   architect the strongest model: planning, and fixes that the builder could not get right
// With no routing configured every request goes to the builder, exactly as before.
import type { Mode } from "@forge/protocol";

export type Tier = "scout" | "builder" | "architect";
export interface Route {
  provider: string;
  model: string;
}

export interface RoutingConfig {
  scout?: Route;
  architect?: Route;
  /**
   * Failed verification rounds after which the architect takes over. The builder gets the rounds before that, so with the
   * default of 2 it has one chance to fix what the checks found and the architect gets the second. Default 2.
   */
  escalateAfter?: number;
  /** Plan mode (high-level design, written once and reviewed) uses the architect. Default true. */
  planWithArchitect?: boolean;
  /**
   * How to size up a request before answering it. "off" (default): everything goes to the builder. "heuristic": free and
   * instant, from the wording and length of the request. "model": ask the scout model (a model call before the answer, with a
   * short timeout; the heuristic answers if it fails).
   */
  triage?: "off" | "heuristic" | "model";
  /** Tiers that must not be used (local-only mode blocks the ones that are remote). They fall back to the builder. */
  disabled?: Tier[];
}

export interface TierChoice {
  tier: Tier;
  route: Route;
  /** Why, in words the developer can read. */
  reason: string;
}

export type Complexity = "trivial" | "standard" | "complex";

const available = (cfg: RoutingConfig, tier: "scout" | "architect"): Route | undefined => (cfg.disabled?.includes(tier) ? undefined : cfg[tier]);

/** The scout route if one is set and allowed, else the builder (for chores that any model can do). */
export function scoutOrBuilder(cfg: RoutingConfig | undefined, builder: Route): Route {
  return (cfg && available(cfg, "scout")) || builder;
}

/** Which model answers the next request. A pure function of the config, the mode and how the run is going. */
export function pickTier(cfg: RoutingConfig | undefined, builder: Route, s: { mode: Mode; failedChecks: number; complexity?: Complexity }): TierChoice {
  const base: TierChoice = { tier: "builder", route: builder, reason: "default model" };
  if (!cfg) return base;
  const architect = available(cfg, "architect");
  const scout = available(cfg, "scout");
  const after = cfg.escalateAfter ?? 2;

  if (s.failedChecks >= after) {
    if (architect) return { tier: "architect", route: architect, reason: `checks failed ${s.failedChecks} times with the default model, so the architect model takes over` };
    return { ...base, reason: `checks failed ${s.failedChecks} times; no architect model is ${cfg.architect ? "allowed" : "set"}, so the default model keeps trying` };
  }
  if (s.mode === "plan" && (cfg.planWithArchitect ?? true) && architect) return { tier: "architect", route: architect, reason: "plan mode" };
  if (s.complexity === "complex" && architect) return { tier: "architect", route: architect, reason: "the request looks complex" };
  if (s.complexity === "trivial" && scout && s.mode !== "plan") return { tier: "scout", route: scout, reason: "the request looks simple" };
  return base;
}

const ARCH_WORDS = /\b(architecture|architect|redesign|re-design|schema|migrat\w*|rewrite|from scratch|race condition|deadlock|concurren\w*|memory leak|root cause|performance regression|threat model)\b/i;
const QUESTION = /^(what|where|which|who|when|how|why|is|are|does|do|can|could|should|explain|show|list|find|tell me|describe|summari[sz]e)\b/i;
const TINY_EDIT = /^(rename|fix (a |the )?typo|add (a )?comment|change (the )?(\w+ ){0,2}(colou?r|text|label|title|wording)|update (the )?(readme|docs?|changelog|comment)|bump)\b/i;
const HEAVY = /\b(refactor|architecture|across|every|all (the )?files|entire|whole (repo|codebase|project)|migrat\w*|rewrite)\b/i;
const FILE_REF = /[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|cs|cpp|c|h|css|html|json|md|toml|ya?ml)\b/gi;

/** A free, instant first guess at how big a request is, from its wording and length. Conservative: it only calls things trivial or complex on clear signals. */
export function classifyPrompt(prompt: string, mode: Mode): { complexity: Complexity; reason: string } {
  const text = prompt.trim();
  const files = new Set(text.match(FILE_REF) ?? []).size;
  const signals = [ARCH_WORDS.test(text), text.length > 400, files >= 3].filter(Boolean).length;
  if (signals >= 2) return { complexity: "complex", reason: "design or debugging words together with a long request or several files" };
  if (!HEAVY.test(text) && files <= 1) {
    if (mode === "ask" && text.length < 200 && QUESTION.test(text)) return { complexity: "trivial", reason: "a short question" };
    if ((mode === "agent" || mode === "debug") && text.length < 140 && TINY_EDIT.test(text)) return { complexity: "trivial", reason: "a small, well-defined edit" };
  }
  return { complexity: "standard", reason: "an ordinary request" };
}

/** Reads the scout model's one-word answer to the triage prompt; anything else means "no answer". */
export function parseComplexity(answer: string): Complexity | null {
  const w = answer.trim().toLowerCase().match(/[a-z]+/)?.[0];
  return w === "trivial" || w === "standard" || w === "complex" ? w : null;
}

export const TRIAGE_PROMPT = `Size up the coding request below for routing. Reply with exactly one word.
trivial: a short question, or a small well-defined edit (rename, typo, comment, colour, wording).
standard: ordinary feature or bug work in a few files.
complex: architecture, design or schema work, or hard debugging that spans many files or needs deep reasoning.
When unsure, answer standard.`;
