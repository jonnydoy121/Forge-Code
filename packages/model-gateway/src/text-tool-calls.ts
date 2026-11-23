import type { ToolCall } from "@forge/protocol";

// Some local models (Qwen2.5-coder through Ollama among them) pick the right tool with the right arguments but write the call
// as JSON in the message text instead of the structured `tool_calls` field. The agent loop would treat that as a plain answer and
// never run it. This reads such a reply back as tool calls, but only when the WHOLE reply is calls to tools that were offered:
// prose with some JSON in it, or a call to a name that was not offered, stays a normal answer.

/** Could this text, so far, be the start of a tool call written as text? Undefined while it is too short to tell. */
export function mayBeTextToolCall(soFar: string): boolean | undefined {
  const t = soFar.trimStart();
  if (!t) return undefined;
  // JSON begins {" (or {}) and [{ (or []): anything else after the bracket ("[1] The fix is...") is ordinary text, shown at once.
  if (t[0] === "{" || t[0] === "[") {
    const next = t.slice(1).trimStart()[0];
    if (next === undefined) return undefined;
    return t[0] === "{" ? next === '"' || next === "}" : next === "{" || next === "]";
  }
  for (const marker of ["<tool_call>", "```"]) {
    if (t.startsWith(marker)) return true;
    if (marker.startsWith(t)) return undefined; // a prefix of the marker so far: wait for more
  }
  return false;
}

/** Splits text into its top-level JSON objects/arrays, or null if there is anything else in it but whitespace. */
function topLevelJson(text: string): unknown[] | null {
  const out: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c !== "{" && c !== "[") return null;
    let depth = 0;
    let inString = false;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (inString) {
        if (ch === "\\") j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return null;
    try {
      out.push(JSON.parse(text.slice(i, j + 1)));
    } catch {
      return null;
    }
    i = j + 1;
  }
  return out;
}

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function toCall(v: unknown, names: Set<string>, id: string): ToolCall | null {
  const o = asObject(v);
  if (!o) return null;
  // {"type":"function","function":{"name":..,"arguments":..}} as OpenAI writes it, or the flat {"name":..,"arguments":..}
  const f = asObject(o.function) ?? o;
  if (typeof f.name !== "string" || !names.has(f.name)) return null;
  let args: unknown = f.arguments ?? f.parameters ?? f.args ?? f.input ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  const a = asObject(args);
  return a ? { id, name: f.name, args: a } : null;
}

/** The tool calls the text consists of, or null when it is not purely calls to the offered tools. */
export function recoverToolCalls(text: string, toolNames: string[]): ToolCall[] | null {
  if (!toolNames.length) return null;
  let t = text.trim();
  if (!t) return null;
  // Remove the wrappers models put around it: a code fence, or <tool_call> tags.
  t = t.replace(/^```[\w-]*\s*/, "").replace(/\s*```$/, "").replace(/<\/?tool_call>/g, " ").trim();
  const values = topLevelJson(t);
  if (!values?.length) return null;
  const names = new Set(toolNames);
  const calls: ToolCall[] = [];
  for (const v of values.flatMap((x) => (Array.isArray(x) ? x : [x]))) {
    const c = toCall(v, names, `call_text_${calls.length + 1}`);
    if (!c) return null; // one unrecognised piece and the whole reply is treated as text
    calls.push(c);
  }
  return calls;
}
