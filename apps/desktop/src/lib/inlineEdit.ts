// Inline edit: select code, describe the change, review the result as a normal pending change.

export interface InlineContext {
  path: string;
  language: string;
  /** whole file text and the selection as offsets into it */
  text: string;
  start: number;
  end: number;
}

const CONTEXT_CHARS = 1500;

/** One-shot prompt (no tools): the model must answer with only the replacement for the selection. */
export function buildInlinePrompt(ctx: InlineContext, instruction: string): string {
  const selected = ctx.text.slice(ctx.start, ctx.end);
  const before = ctx.text.slice(Math.max(0, ctx.start - CONTEXT_CHARS), ctx.start);
  const after = ctx.text.slice(ctx.end, ctx.end + CONTEXT_CHARS);
  const target = selected === "" ? "Insert new code at the cursor (marked <<CURSOR>>)." : "Rewrite the selected code (between <<SELECTION>> and <</SELECTION>>).";
  return [
    `You are editing ${ctx.path} (${ctx.language}). ${target}`,
    `Instruction: ${instruction}`,
    "Reply with ONLY the replacement code: no explanation, no markdown fences, keep the surrounding indentation style.",
    "",
    "File excerpt:",
    "```",
    before + (selected === "" ? "<<CURSOR>>" : `<<SELECTION>>${selected}<</SELECTION>>`) + after,
    "```",
  ].join("\n");
}

/** Models often wrap code in a fence despite instructions: unwrap a single fenced block, otherwise keep the text. */
export function extractReplacement(reply: string): string {
  const t = reply.replace(/^\s*\n/, "").replace(/\s+$/, "");
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t.trim());
  return m ? m[1]! : t;
}

export function spliceSelection(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}
