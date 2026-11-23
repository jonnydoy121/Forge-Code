// A few words about what a tool call touched ("src/app.ts", "npm test"), shown next to the tool's name so a collapsed row says
// something without opening it. Other agent UIs do the same: the name alone ("read_file") tells you little.

const KEYS = ["path", "file", "pattern", "query", "command", "url", "name", "skill", "symbol", "task", "title"];

/** The most telling argument, shortened, or "" when there is none. Never throws on odd input. */
export function toolSummary(args: unknown, max = 70): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const a = args as Record<string, unknown>;
  for (const k of KEYS) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return shorten(v, max);
    if (typeof v === "number") return String(v);
  }
  return "";
}

function shorten(v: string, max: number): string {
  const line = v.trim().split(/\r?\n/)[0]!.replace(/\s+/g, " ");
  const more = v.trim().includes("\n") || line.length > max;
  return more ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
