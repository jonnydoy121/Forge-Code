// Settings -> the routing config the agent loop uses, and the questions the UI asks about it (is anything remote? what changed?).
import type { Route, RoutingConfig } from "@forge/agent-runtime";
import type { AgentSettings } from "./settings";

export type TierName = "scout" | "architect";
export type ProviderKind = AgentSettings["provider"];

/** Gateway provider name for a tier. The builder is "default". */
export const tierProvider = (t: TierName) => t;

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;
const DEFAULT_HOST: Record<ProviderKind, string> = { ollama: "http://127.0.0.1:11434/v1", anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1" };

/** What a tier is set to, or null when it is off (no provider chosen or no model named). */
export function tierSetting(s: AgentSettings, t: TierName): { kind: ProviderKind; model: string; baseUrl: string } | null {
  const kind = t === "scout" ? s.scoutProvider : s.architectProvider;
  const model = (t === "scout" ? s.scoutModel : s.architectModel).trim();
  const baseUrl = (t === "scout" ? s.scoutBaseUrl : s.architectBaseUrl).trim();
  return kind && model ? { kind, model, baseUrl } : null;
}

/** True when a request to this tier would leave the machine. */
export function tierIsRemote(s: AgentSettings, t: TierName): boolean {
  const cfg = tierSetting(s, t);
  return !!cfg && !LOCAL.test(cfg.baseUrl || DEFAULT_HOST[cfg.kind]);
}

/** Tiers that must not be used: in local-only mode every remote one (a blocked request would fail the run instead of falling back). */
export function disabledTiers(s: AgentSettings): TierName[] {
  return s.localOnly ? (["scout", "architect"] as const).filter((t) => tierIsRemote(s, t)) : [];
}

/** The routing config for the loop, or undefined when nothing is configured (then every request goes to the main model, as before). */
export function routingFromSettings(s: AgentSettings): RoutingConfig | undefined {
  const scout = tierSetting(s, "scout");
  const architect = tierSetting(s, "architect");
  if (!scout && !architect && s.triage === "off") return undefined;
  const route = (t: TierName, cfg: NonNullable<ReturnType<typeof tierSetting>>): Route => ({ provider: tierProvider(t), model: cfg.model });
  const disabled = disabledTiers(s);
  return {
    ...(scout ? { scout: route("scout", scout) } : {}),
    ...(architect ? { architect: route("architect", architect) } : {}),
    escalateAfter: Math.max(1, Math.round(s.escalateAfter) || 2),
    triage: s.triage,
    ...(disabled.length ? { disabled } : {}),
  };
}

/** True when any tier that could be used sends prompts off this machine (the privacy badge must count them, not just the main model). */
export function tiersSendOffMachine(s: AgentSettings): boolean {
  const off = disabledTiers(s);
  return (["scout", "architect"] as const).some((t) => !off.includes(t) && tierIsRemote(s, t));
}
