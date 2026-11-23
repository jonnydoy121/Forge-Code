// A small markdown parser for assistant replies: code (fenced and inline), emphasis, headings, lists, links shown as text.
// It produces a plain data structure; components turn that into React elements, so reply text is never inserted as HTML.

export type Inline = { type: "text"; text: string } | { type: "code"; text: string } | { type: "bold"; children: Inline[] } | { type: "italic"; children: Inline[] } | { type: "link"; text: string; url: string };

export type Block =
  | { type: "code"; lang: string; text: string; closed: boolean }
  | { type: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "para"; inline: Inline[] };

const TOKEN = /(`[^`\n]+`)|(\*\*(?!\s)[^*\n]+?(?<!\s)\*\*)|(\*(?!\s)[^*\n]+?(?<!\s)\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index!;
    if (i > last) out.push({ type: "text", text: text.slice(last, i) });
    const [raw] = m;
    if (m[1]) out.push({ type: "code", text: raw.slice(1, -1) });
    else if (m[2]) out.push({ type: "bold", children: parseInline(raw.slice(2, -2)) });
    else if (m[3]) out.push({ type: "italic", children: parseInline(raw.slice(1, -1)) });
    else {
      const k = raw.indexOf("](");
      out.push({ type: "link", text: raw.slice(1, k), url: raw.slice(k + 2, -1) });
    }
    last = i + raw.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*\S)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/** Blocks of a reply. An unterminated code fence (the reply is still streaming) is treated as code to the end. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "para", inline: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      let closed = false;
      // The block ends at a line made only of the same fence character, at least as many times as it opened with.
      const closer = new RegExp(`^\\s{0,3}${fence[1]![0] === "`" ? "`" : "~"}{${fence[1]!.length},}\\s*$`);
      for (i++; i < lines.length; i++) {
        if (closer.test(lines[i]!)) {
          closed = true;
          break;
        }
        body.push(lines[i]!);
      }
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n"), closed });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ type: "heading", level: h[1]!.length as 1 | 2 | 3, inline: parseInline(h[2]!) });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flush();
      const ordered = !!n;
      const items: Inline[][] = [];
      for (; i < lines.length; i++) {
        const m = (ordered ? NUMBERED : BULLET).exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
      }
      i--; // the loop's own increment moves past the last item
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line);
  }
  flush();
  return blocks;
}
