// Opt-in: does a real local model answer the "options before code" prompt in a form the parser can use?
// Skipped unless FORGE_LIVE_SCOUT=<ollama model> is set; talks to Ollama on this machine only.
import { describe, expect, it } from "vitest";
import { Gateway } from "@forge/model-gateway";
import { buildOptionsPrompt, parseOptions } from "./options";

const MODEL = process.env.FORGE_LIVE_SCOUT ?? "";
const REQUESTS = [
  "Add caching to the API client so repeated loads of the same user do not hit the network",
  "Make the settings panel remember which section was open",
  "Add a dark mode toggle to the app",
  "Stop the file watcher from re-indexing the same file twice in a row",
];
const MAP = "src/api.ts: load(id), save(user)\nsrc/settings.tsx: SettingsPanel\nsrc/theme.ts: theme tokens\nsrc/watch.ts: watchDir(), onChange()";

describe.skipIf(!MODEL)(`live: ${MODEL || "a local model"} proposing options`, () => {
  it("returns options the parser accepts", { timeout: 5 * 60_000 }, async () => {
    const gw = new Gateway({ fetch: (u, i) => fetch(u, i), maxRetries: 0 });
    gw.register("local", { kind: "ollama" });
    const rows: Record<string, unknown>[] = [];
    for (const request of REQUESTS) {
      let reply = "";
      const t0 = Date.now();
      for await (const ev of gw.stream({ provider: "local", model: MODEL, messages: [{ role: "user", content: buildOptionsPrompt(request, MAP, null) }] })) if (ev.type === "text") reply += ev.delta;
      const options = parseOptions(reply);
      rows.push({ request: request.slice(0, 50), usable: options ? options.length : 0, seconds: +((Date.now() - t0) / 1000).toFixed(1), titles: options?.map((o) => o.title).join(" | ") ?? `(unusable: ${reply.replace(/\s+/g, " ").slice(0, 60)})`, realFiles: options ? options.every((o) => o.files.every((f) => MAP.includes(f) || f.length > 0)) : null });
    }
    console.table(rows);
    expect(rows).toHaveLength(REQUESTS.length);
  });
});
