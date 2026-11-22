// A small YAML-subset front matter parser: scalars, booleans, inline arrays and "- item" lists.

export type FrontValue = string | boolean | string[];
export interface Parsed { data: Record<string, FrontValue>; body: string }

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

function scalar(raw: string): FrontValue {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map(unquote)
      .filter(Boolean);
  }
  return unquote(v);
}

export function parseFrontmatter(text: string): Parsed {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, FrontValue> = {};
  let listKey: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = data[listKey];
      data[listKey] = [...(Array.isArray(cur) ? cur : []), unquote(item[1]!)];
      continue;
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v === "") {
      listKey = k!;
      data[k!] = [];
    } else {
      listKey = null;
      data[k!] = scalar(v!);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

export const asString = (v: FrontValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);
export const asList = (v: FrontValue | undefined): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []);

export function stringifyFrontmatter(data: Record<string, FrontValue>, body: string): string {
  const lines = Object.entries(data).map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]` : `${k}: ${typeof v === "string" ? v.replace(/\n/g, " ") : v}`));
  return `---\n${lines.join("\n")}\n---\n${body.replace(/^\n+/, "")}`;
}
