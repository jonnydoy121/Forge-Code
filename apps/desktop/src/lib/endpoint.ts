import type { FetchLike } from "@forge/model-gateway";

export interface EndpointCheck {
  ok: boolean;
  /** HTTP status when the server answered */
  status?: number;
  /** model ids the endpoint lists (OpenAI-compatible `GET /models`) */
  models: string[];
  /** one plain sentence for the developer */
  message: string;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Ask an OpenAI-compatible endpoint what it is: `GET <base>/models` with the key. This sends only the key, to the address the developer
 * typed, and no code. A blank address means OpenAI's own.
 */
export async function checkEndpoint(fetchFn: FetchLike, baseUrl: string, apiKey: string): Promise<EndpointCheck> {
  const base = (baseUrl.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetchFn(`${base}/models`, { method: "GET", headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
  } catch (e) {
    return { ok: false, models: [], message: `Could not reach ${base}: ${e instanceof Error ? e.message : String(e)}. Is the server running, and is the address right?` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: string | { message?: string } };
      detail = typeof j.error === "string" ? j.error : (j.error?.message ?? text);
    } catch {
      /* not JSON: show the text */
    }
    const hint = res.status === 401 || res.status === 403 ? " Check the API key." : res.status === 404 ? " This address may not be an OpenAI-compatible /v1 endpoint." : "";
    return { ok: false, status: res.status, models: [], message: `The server answered ${res.status}${detail ? `: ${clip(detail)}` : ""}.${hint}` };
  }
  let models: string[] = [];
  try {
    const j = JSON.parse(text) as { data?: { id?: unknown }[] };
    models = (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
  } catch {
    return { ok: false, status: res.status, models: [], message: "The server answered, but not with an OpenAI-style model list. It may not be an OpenAI-compatible endpoint." };
  }
  return { ok: true, status: res.status, models, message: models.length ? `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available.` : "Connected, but the server lists no models." };
}
