import type { Message } from "@forge/protocol";

/** Rough token estimate (about 4 characters per token). Accurate enough for budgeting and the meter. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export interface ContextSection {
  id: string;
  label: string;
  text: string;
  /** Lower number = more important. rules 0, plan 1, task files 2, repo map 3, retrieved 4. */
  priority: number;
}

export interface MeterEntry { id: string; label: string; tokens: number; trimmed: boolean }

export interface AssembledContext {
  system: string;
  history: Message[];
  meter: MeterEntry[];
  totalTokens: number;
}

const historyTokens = (m: Message) =>
  estimateTokens(m.content) + estimateTokens(JSON.stringify(m.toolCalls ?? [])) + 4;

/**
 * Assemble context within a token budget. Priority: rules > plan > task files > repo map > retrieved chunks >
 * older conversation. Trims from the bottom: whole lowest-priority sections go first (the last one that
 * partly fits is truncated), then the oldest conversation turns. The newest user message is always kept.
 */
export function assembleContext(opts: { base: string; sections: ContextSection[]; history: Message[]; budget: number }): AssembledContext {
  const meter: MeterEntry[] = [];
  let remaining = opts.budget - estimateTokens(opts.base);
  const keptSections: ContextSection[] = [];

  // Reserve room for the newest user message first.
  const lastUser = [...opts.history].reverse().find((m) => m.role === "user");
  remaining -= lastUser ? historyTokens(lastUser) : 0;

  for (const s of [...opts.sections].sort((a, b) => a.priority - b.priority)) {
    const t = estimateTokens(`## ${s.label}
${s.text}`);
    if (t <= remaining) {
      keptSections.push(s);
      remaining -= t;
      meter.push({ id: s.id, label: s.label, tokens: t, trimmed: false });
    } else if (remaining > 200) {
      const cut = s.text.slice(0, remaining * 4) + "\n[truncated to fit token budget]";
      keptSections.push({ ...s, text: cut });
      meter.push({ id: s.id, label: s.label, tokens: remaining, trimmed: true });
      remaining = 0;
    } else {
      meter.push({ id: s.id, label: s.label, tokens: 0, trimmed: true });
    }
  }

  // Keep the most recent conversation that fits; never split a tool call from its results.
  const kept: Message[] = [];
  let used = 0;
  for (let i = opts.history.length - 1; i >= 0; i--) {
    const m = opts.history[i]!;
    const t = historyTokens(m);
    if (m === lastUser || used + t <= remaining + (lastUser ? 0 : 0)) {
      kept.unshift(m);
      if (m !== lastUser) used += t;
    } else break;
  }
  // Drop a leading tool message whose assistant call was trimmed away.
  while (kept[0]?.role === "tool") kept.shift();
  const convTokens = kept.reduce((n, m) => n + historyTokens(m), 0);
  meter.push({ id: "conversation", label: "Conversation", tokens: convTokens, trimmed: kept.length < opts.history.length });

  const system = [opts.base, ...keptSections.map((s) => `## ${s.label}\n${s.text}`)].join("\n\n");
  const total = estimateTokens(system) + convTokens;
  meter.unshift({ id: "system", label: "System prompt", tokens: estimateTokens(opts.base), trimmed: false });
  return { system, history: kept, meter, totalTokens: total };
}

/**
 * Learns how far the character-based estimate is from what the provider actually counts, so the token meter
 * can be calibrated against reported usage. Local models that report no usage keep the raw estimate.
 */
export class TokenCalibrator {
  private ratios: number[] = [];
  constructor(private window = 8) {}

  /** Record one request: our estimate vs the provider's reported input tokens. */
  observe(estimated: number, reported: number) {
    if (estimated > 0 && reported > 0) {
      this.ratios.push(reported / estimated);
      if (this.ratios.length > this.window) this.ratios.shift();
    }
  }

  get ratio(): number {
    return this.ratios.length ? this.ratios.reduce((a, b) => a + b, 0) / this.ratios.length : 1;
  }

  get samples() {
    return this.ratios.length;
  }

  adjust(estimate: number): number {
    return Math.round(estimate * this.ratio);
  }
}
