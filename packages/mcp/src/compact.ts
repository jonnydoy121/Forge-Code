// An MCP server can return anything, including a dump of a whole game scene or a build log of a million lines. Sent to the model as is,
// one call fills the context. This shrinks a big result locally (no model call, deterministic) and says what it cut:
//   JSON:       arrays keep their first items, deep levels and long strings are cut, each with a note of what is missing
//   other text: the beginning and the end are kept (a build log's cause is usually at the end), the middle is cut
// A result under the limit is returned unchanged.

export const DEFAULT_MAX_CHARS = 12_000;
const HEADER_RESERVE = 260;

interface Shape {
  items: number;
  keys: number;
  depth: number;
  str: number;
}

// From gentle to harsh; the first that fits wins.
const SHAPES: Shape[] = [
  { items: 20, keys: 40, depth: 8, str: 400 },
  { items: 10, keys: 30, depth: 6, str: 200 },
  { items: 5, keys: 20, depth: 5, str: 120 },
  { items: 3, keys: 12, depth: 4, str: 80 },
  { items: 2, keys: 8, depth: 3, str: 60 },
];

const more = (n: number, what: string) => `… ${n.toLocaleString("en-US")} more ${what}`;

function prune(v: unknown, shape: Shape, depth: number): unknown {
  if (typeof v === "string") return v.length > shape.str ? `${v.slice(0, shape.str)}… (+${(v.length - shape.str).toLocaleString("en-US")} characters)` : v;
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    if (depth >= shape.depth) return `[… ${v.length.toLocaleString("en-US")} items]`;
    const kept = v.slice(0, shape.items).map((x) => prune(x, shape, depth + 1));
    return v.length > shape.items ? [...kept, more(v.length - shape.items, "items")] : kept;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (depth >= shape.depth) return `{… ${entries.length.toLocaleString("en-US")} keys}`;
  const out: Record<string, unknown> = {};
  for (const [k, x] of entries.slice(0, shape.keys)) out[k] = prune(x, shape, depth + 1);
  if (entries.length > shape.keys) out["…"] = more(entries.length - shape.keys, "keys");
  return out;
}

function headTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}\n[… ${(text.length - head - tail).toLocaleString("en-US")} characters omitted …]\n${text.slice(text.length - tail)}`;
}

export interface Compacted {
  text: string;
  compacted: boolean;
  before: number;
  after: number;
}

/** `label` names the tool in the note that tells the model (and the developer) what happened. */
export function compactResult(text: string, label: string, maxChars = DEFAULT_MAX_CHARS): Compacted {
  const before = text.length;
  if (before <= maxChars) return { text, compacted: false, before, after: before };
  const budget = Math.max(200, maxChars - HEADER_RESERVE);

  let body: string | null = null;
  let how = "the beginning and the end are kept";
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      for (const shape of SHAPES) {
        const candidate = JSON.stringify(prune(parsed, shape, 0));
        body = candidate;
        if (candidate.length <= budget) break;
      }
      how = "arrays show their first items, and deep levels and long text are cut";
      if (body!.length > budget) body = headTail(body!, budget); // even the harshest shape is too big (very wide objects)
    } catch {
      body = null; // not JSON after all
    }
  }
  if (body === null) body = headTail(text, budget);

  const note = `[Result from ${label} compacted locally: ${before.toLocaleString("en-US")} characters -> ${body.length.toLocaleString("en-US")}; ${how}. Ask again with a narrower query for the rest.]`;
  const out = `${note}\n${body}`;
  return { text: out, compacted: true, before, after: out.length };
}
