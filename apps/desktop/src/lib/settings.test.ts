import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, sendsCodeOffMachine } from "./settings";

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
