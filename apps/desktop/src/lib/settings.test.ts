import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, ENDPOINT_PRESETS, loadSettings, onSettingsChange, presetFor, saveSettings, sendsCodeOffMachine } from "./settings";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("settings", () => {
  it("defaults to a local provider", () => {
    expect(loadSettings(memory())).toEqual(DEFAULT_SETTINGS);
    expect(sendsCodeOffMachine(DEFAULT_SETTINGS)).toBe(false);
  });
  it("round-trips and tolerates corrupt storage", () => {
    const s = memory();
    saveSettings({ ...DEFAULT_SETTINGS, model: "x" }, s);
    expect(loadSettings(s).model).toBe("x");
    s.setItem("forge.settings.v1", "{not json");
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
  });
  it("flags hosted providers and remote base URLs as off-machine", () => {
    expect(sendsCodeOffMachine({ ...DEFAULT_SETTINGS, provider: "anthropic" })).toBe(true);
    expect(sendsCodeOffMachine({ ...DEFAULT_SETTINGS, baseUrl: "http://10.0.0.5:11434/v1" })).toBe(true);
    expect(sendsCodeOffMachine({ ...DEFAULT_SETTINGS, provider: "openai", baseUrl: "http://127.0.0.1:8080/v1" })).toBe(false);
  });
});

describe("api key storage", () => {
  it("never writes the API key to local storage", () => {
    const s = memory();
    saveSettings({ ...DEFAULT_SETTINGS, apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwx" }, s);
    expect(s.getItem("forge.settings.v1")).not.toContain("sk-ant");
    expect(loadSettings(s).apiKey).toBe("");
  });
});

describe("settings change notification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tells listeners when settings are saved, so nothing has to poll", () => {
    vi.stubGlobal("window", new EventTarget());
    let calls = 0;
    const off = onSettingsChange(() => calls++);
    saveSettings({ ...DEFAULT_SETTINGS, localOnly: true }, memory());
    saveSettings({ ...DEFAULT_SETTINGS, localOnly: false }, memory());
    expect(calls).toBe(2);
    off();
    saveSettings(DEFAULT_SETTINGS, memory());
    expect(calls).toBe(2); // unsubscribed
  });

  it("is a no-op outside a browser", () => {
    expect(() => onSettingsChange(() => {})()).not.toThrow();
    expect(() => saveSettings(DEFAULT_SETTINGS, memory())).not.toThrow();
  });
});

describe("endpoint presets", () => {
  it("recognises a preset by its base URL, ignoring a trailing slash, and calls anything else custom", () => {
    expect(presetFor("")).toBe("openai");
    expect(presetFor("https://openrouter.ai/api/v1/")).toBe("openrouter");
    expect(presetFor(" http://localhost:1234/v1 ")).toBe("lmstudio");
    expect(presetFor("http://example.test/v1")).toBe("custom");
  });

  it("gives every preset a distinct address and a model, with OpenAI as the default address", () => {
    const urls = ENDPOINT_PRESETS.map((p) => p.baseUrl);
    expect(new Set(urls).size).toBe(urls.length);
    expect(ENDPOINT_PRESETS.every((p) => p.model.length > 0)).toBe(true);
    expect(ENDPOINT_PRESETS[0]).toMatchObject({ id: "openai", baseUrl: "" });
  });
});
