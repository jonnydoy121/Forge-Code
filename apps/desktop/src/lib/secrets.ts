import { invoke } from "@tauri-apps/api/core";

/** Keychain entry name for a provider's API key. */
export const apiKeyName = (provider: string) => `api-key:${provider}`;

const inTauri = () => "__TAURI_INTERNALS__" in window;

export async function loadApiKey(provider: string): Promise<string> {
  if (!inTauri()) return "";
  return (await invoke<string | null>("secret_get", { name: apiKeyName(provider) }).catch(() => null)) ?? "";
}

export async function storeApiKey(provider: string, key: string): Promise<void> {
  if (!inTauri()) return;
  if (key) await invoke("secret_set", { name: apiKeyName(provider), value: key });
  else await invoke("secret_delete", { name: apiKeyName(provider) });
}

/** One-time move of a key that an earlier version saved in local storage into the OS credential store. */
export async function migrateLegacyKey(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): Promise<void> {
  try {
    const raw = storage.getItem("forge.settings.v1");
    if (!raw) return;
    const s = JSON.parse(raw) as { apiKey?: string; provider?: string };
    if (s.apiKey) {
      await storeApiKey(s.provider ?? "anthropic", s.apiKey);
      storage.setItem("forge.settings.v1", JSON.stringify({ ...s, apiKey: "" }));
    }
  } catch {
    /* unreadable settings: nothing to migrate */
  }
}
