import type { FetchLike } from "@forge/model-gateway";

/** Tauri's HTTP plugin bypasses webview CORS (needed for Ollama and some providers); plain fetch outside Tauri. */
export async function pickFetch(): Promise<FetchLike> {
  if ("__TAURI_INTERNALS__" in window) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return (url, init) => fetch(url, init);
  }
  return (url, init) => fetch(url, init);
}

/** GET a URL as text. Only called for pages the developer explicitly asked to fetch. */
export async function fetchText(url: string): Promise<string> {
  const f = await pickFetch();
  const r = await f(url, { method: "GET", headers: { accept: "text/html,text/plain,text/markdown" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return (await r.text()).slice(0, 2_000_000);
}
