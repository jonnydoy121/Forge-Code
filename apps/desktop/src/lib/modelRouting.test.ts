import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AgentSettings } from "./settings";
import { disabledTiers, routingFromSettings, tierIsRemote, tierSetting, tiersSendOffMachine } from "./modelRouting";

const s = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_SETTINGS, ...over });
const tiered = (over: Partial<AgentSettings> = {}) => s({ scoutProvider: "ollama", scoutModel: "qwen2.5-coder:7b", architectProvider: "anthropic", architectModel: "claude-opus-5-5", ...over });

describe("routingFromSettings", () => {
  it("is undefined when nothing is configured, so every request keeps using the main model", () => {
    expect(routingFromSettings(s())).toBeUndefined();
  });

  it("names each configured tier by its gateway provider and leaves the others out", () => {
    expect(routingFromSettings(tiered())).toEqual({ scout: { provider: "scout", model: "qwen2.5-coder:7b" }, architect: { provider: "architect", model: "claude-opus-5-5" }, escalateAfter: 2, triage: "off" });
    const only = routingFromSettings(s({ architectProvider: "anthropic", architectModel: "claude-opus-5-5" }))!;
    expect(only.scout).toBeUndefined();
    expect(only.architect).toEqual({ provider: "architect", model: "claude-opus-5-5" });
  });

  it("treats a tier as off unless it has both a provider and a model name", () => {
    expect(tierSetting(s({ scoutProvider: "ollama", scoutModel: "  " }), "scout")).toBeNull();
    expect(tierSetting(s({ scoutProvider: "", scoutModel: "x" }), "scout")).toBeNull();
    expect(routingFromSettings(s({ scoutProvider: "ollama" }))).toBeUndefined();
  });

  it("carries triage and a sane escalation threshold even with no tiers (triage alone is a valid configuration)", () => {
    expect(routingFromSettings(s({ triage: "heuristic" }))).toMatchObject({ triage: "heuristic", escalateAfter: 2 });
    expect(routingFromSettings(tiered({ escalateAfter: 3 }))!.escalateAfter).toBe(3);
    expect(routingFromSettings(tiered({ escalateAfter: 0 }))!.escalateAfter).toBe(2);
    expect(routingFromSettings(tiered({ escalateAfter: -4 }))!.escalateAfter).toBe(1);
  });
});

describe("local-only mode", () => {
  it("disables the remote tiers and keeps the local ones", () => {
    expect(disabledTiers(tiered({ localOnly: true }))).toEqual(["architect"]);
    expect(routingFromSettings(tiered({ localOnly: true }))!.disabled).toEqual(["architect"]);
    expect(disabledTiers(tiered({ localOnly: false }))).toEqual([]);
    expect(routingFromSettings(tiered())!.disabled).toBeUndefined();
  });

  it("counts a tier as local only by its endpoint: a local OpenAI-compatible server is local, a custom remote Ollama is not", () => {
    expect(tierIsRemote(tiered({ scoutProvider: "openai", scoutBaseUrl: "http://127.0.0.1:1234/v1" }), "scout")).toBe(false);
    expect(tierIsRemote(tiered({ scoutProvider: "ollama", scoutBaseUrl: "http://10.0.0.5:11434/v1" }), "scout")).toBe(true);
    expect(tierIsRemote(tiered(), "scout")).toBe(false); // Ollama's default is this machine
    expect(tierIsRemote(tiered(), "architect")).toBe(true); // Anthropic's default is not
    expect(tierIsRemote(s(), "scout")).toBe(false); // not configured: nothing to send
  });
});

describe("tiersSendOffMachine (the privacy badge)", () => {
  it("is true when a tier that could be used is remote, even if the main model is local", () => {
    expect(tiersSendOffMachine(s())).toBe(false);
    expect(tiersSendOffMachine(tiered())).toBe(true);
    expect(tiersSendOffMachine(s({ scoutProvider: "ollama", scoutModel: "small" }))).toBe(false);
  });
  it("ignores a remote tier that local-only mode has disabled, because it will never be called", () => {
    expect(tiersSendOffMachine(tiered({ localOnly: true }))).toBe(false);
  });
});
