// "Options before code": for a request that has more than one reasonable way to do it, ask for 2-3 short approaches first, let the
// developer pick, and only then run the agent on the chosen one. No code is written for the options that are not picked.

export interface Option {
  title: string;
  summary: string;
  /** files the approach would probably touch (the model's guess, grounded in the repo map) */
  files: string[];
  tradeoff: string;
  size: "small" | "medium" | "large";
}

const MAX_MAP_CHARS = 3000;

export function buildOptionsPrompt(request: string, repoMap: string | null, activeFile?: string | null): string {
  return [
    "A developer wants this done in their codebase. Before any code is written, suggest 2 or 3 genuinely different approaches so they can pick one.",
    "Do NOT write code. Keep each approach short.",
    'Reply with JSON only, in exactly this shape: {"options":[{"title":"up to 6 words","summary":"up to 40 words on how it works","files":["paths it would probably change"],"tradeoff":"up to 20 words on what you give up","size":"small|medium|large"}]}',
    "Use real file paths from the repo map where it helps; do not invent files that cannot exist.",
    `Request: ${request}`,
    activeFile ? `The developer has this file open: ${activeFile}` : "",
    repoMap ? `Repo map:\n${repoMap.slice(0, MAX_MAP_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Pull the first balanced {...} or [...] out of text that may have a fence or a sentence around it. */
function jsonObject(text: string): unknown {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  const start = brace < 0 ? bracket : bracket < 0 ? brace : Math.min(brace, bracket);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The options in a model's reply, or null if there are not at least two usable ones. At most three are kept. */
export function parseOptions(reply: string): Option[] | null {
  const parsed = jsonObject(reply) as { options?: unknown } | null;
  const list = Array.isArray(parsed?.options) ? parsed!.options : Array.isArray(parsed) ? parsed : null;
  if (!list) return null;
  const out: Option[] = [];
  for (const raw of list) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const title = clip(o.title, 80);
    const summary = clip(o.summary, 400);
    if (!title || !summary) continue;
    const size = o.size === "small" || o.size === "large" ? o.size : "medium";
    const files = Array.isArray(o.files) ? o.files.map((f) => clip(f, 120)).filter(Boolean).slice(0, 6) : [];
    out.push({ title, summary, files, tradeoff: clip(o.tradeoff, 200), size });
    if (out.length === 3) break;
  }
  return out.length >= 2 ? out : null;
}

export const optionLetter = (i: number) => String.fromCharCode(65 + i);

/** What the agent is told once the developer has chosen: the original request, the chosen approach, and not to do the others. */
export function approvedPrompt(request: string, o: Option, index: number): string {
  return [
    request,
    `Approved approach (option ${optionLetter(index)}: ${o.title}): ${o.summary}`,
    o.files.length ? `Files likely involved: ${o.files.join(", ")}` : "",
    "Implement this approach only. Do not implement the other options that were suggested.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
