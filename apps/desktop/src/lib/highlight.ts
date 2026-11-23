// Syntax colours for code blocks in the chat, from the same tokenizer the editor uses (Monaco's). The reply text never becomes HTML:
// tokens are turned into plain segments and rendered as React text nodes with a class, so a malicious reply cannot inject markup.

export type TokenClass = "keyword" | "string" | "comment" | "number" | "type" | "tag" | "attr" | "plain";

export interface Segment {
  text: string;
  cls: TokenClass;
}

/** Monaco token types look like "keyword.ts", "string.escape.ts", "type.identifier.ts", "comment.doc.ts". */
export function tokenClass(type: string): TokenClass {
  const t = type.toLowerCase();
  if (t.startsWith("comment")) return "comment";
  if (t.startsWith("string") || t.startsWith("regexp") || t.startsWith("attribute.value")) return "string";
  if (t.startsWith("number") || t.startsWith("constant.numeric")) return "number";
  if (t.startsWith("keyword") || t.startsWith("storage") || t.startsWith("operator.keyword")) return "keyword";
  if (t.startsWith("type")) return "type";
  if (t.startsWith("attribute.name") || t.startsWith("variable.predefined")) return "attr";
  if (t.startsWith("tag") || t.startsWith("metatag")) return "tag";
  return "plain";
}

export interface RawToken {
  offset: number;
  type: string;
}

/**
 * Turn Monaco's tokens (one list per line, each token starting at an offset) into coloured segments per line. Adjacent segments of the
 * same class are merged. Any text the tokens do not cover stays plain, so the output always spells exactly the input text.
 */
export function toSegments(text: string, tokenLines: RawToken[][]): Segment[][] {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const toks = tokenLines[i] ?? [];
    const out: Segment[] = [];
    const push = (s: string, cls: TokenClass) => {
      if (!s) return;
      const last = out[out.length - 1];
      if (last && last.cls === cls) last.text += s;
      else out.push({ text: s, cls });
    };
    if (toks.length === 0) {
      push(line, "plain");
      return out;
    }
    if (toks[0]!.offset > 0) push(line.slice(0, toks[0]!.offset), "plain");
    toks.forEach((t, k) => {
      const end = k + 1 < toks.length ? toks[k + 1]!.offset : line.length;
      push(line.slice(Math.min(t.offset, line.length), Math.min(end, line.length)), tokenClass(t.type));
    });
    return out;
  });
}

export interface LangInfo {
  id: string;
  aliases?: string[];
  extensions?: string[];
}

/** Common fence labels that are not a Monaco language alias. */
const EXTRA: Record<string, string> = { sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", tsx: "typescript", jsx: "javascript", js: "javascript", ts: "typescript", py: "python", yml: "yaml", rs: "rust", golang: "go", "c++": "cpp", "c#": "csharp", cs: "csharp", md: "markdown", ps1: "powershell", pwsh: "powershell" };

/** Which Monaco language a fence label ("ts", "python", "```bash") means, or null when there is none to use. */
export function languageFromFence(label: string, langs: LangInfo[]): string | null {
  const l = label.trim().toLowerCase();
  if (!l) return null;
  const ids = new Set(langs.map((x) => x.id));
  const mapped = EXTRA[l] ?? l;
  if (ids.has(mapped) && mapped !== "plaintext") return mapped;
  const hit = langs.find((x) => x.id !== "plaintext" && ((x.aliases ?? []).some((a) => a.toLowerCase() === l) || (x.extensions ?? []).some((e) => e.toLowerCase() === `.${l}`)));
  return hit?.id ?? null;
}

/** Longest block worth colouring: the tokenizer is fast, but a pasted log is not code. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/** Coloured segments for a closed code block, or null when it should stay plain (unknown language, too long, no engine). Never throws. */
export async function highlight(text: string, fence: string): Promise<Segment[][] | null> {
  if (!text || text.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    const { loadMonaco } = await import("./monaco");
    const { monaco } = await loadMonaco();
    const id = languageFromFence(fence, monaco.languages.getLanguages() as LangInfo[]);
    if (!id) return null;
    await monaco.editor.colorize("", id, {}); // loads the language's tokenizer the first time it is used; the (empty) HTML it returns is thrown away
    return toSegments(text, monaco.editor.tokenize(text, id));
  } catch {
    return null;
  }
}
