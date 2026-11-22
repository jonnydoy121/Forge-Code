// Edit prediction: ghost-text completions at the cursor. Pure prompt building and reply cleanup; the model call and
// the Monaco wiring live elsewhere.

export interface CompletionContext {
  path: string;
  language: string;
  /** all text before and after the cursor */
  prefix: string;
  suffix: string;
}

const BEFORE = 2000;
const AFTER = 600;
const MAX_LINES = 12;
const MAX_CHARS = 800;

/** A chat-style prompt that works with any model (no model-specific fill-in-the-middle tokens). */
export function buildCompletionPrompt(c: CompletionContext): string {
  return [
    `Complete the ${c.language} code in ${c.path} at the marker <<CURSOR>>.`,
    "Reply with ONLY the text to insert at the cursor: no explanation, no markdown fences, do not repeat code that is already there.",
    "Keep it short (a line or a small block). If nothing sensible follows, reply with nothing.",
    "",
    "```",
    c.prefix.slice(-BEFORE) + "<<CURSOR>>" + c.suffix.slice(0, AFTER),
    "```",
  ].join("\n");
}

/** Turn a model reply into the text to show as ghost text ("" = show nothing). */
export function cleanCompletion(reply: string, c: Pick<CompletionContext, "prefix" | "suffix">): string {
  let t = reply.replace(/\r/g, "");
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (fenced) t = fenced[1]!;
  t = t.replace(/^\n+/, "");
  // Models often restart the line they were given: keep only what comes after what is already typed.
  const lineStart = c.prefix.slice(c.prefix.lastIndexOf("\n") + 1);
  if (lineStart.trim() && t.startsWith(lineStart)) t = t.slice(lineStart.length);
  // ...and often repeat the code that already follows the cursor.
  const next = c.suffix.split("\n")[0]!.trim();
  const body = t.trimEnd();
  if (next && body.endsWith(next) && body.length > next.length) t = body.slice(0, body.length - next.length);
  t = t.split("\n").slice(0, MAX_LINES).join("\n").slice(0, MAX_CHARS).replace(/\s+$/, "");
  if (!t.trim()) return "";
  // A refusal or chatter is not code.
  if (/^(i can(no|')t|sorry|as an ai|here is|here's)/i.test(t.trim())) return "";
  return t;
}

/** Skip completion when it would be noise or wasteful: a comment-only context, or the cursor mid-word with nothing typed. */
export function shouldComplete(c: Pick<CompletionContext, "prefix" | "suffix">): boolean {
  if (c.prefix.trim() === "" && c.suffix.trim() === "") return false; // empty file
  const lineStart = c.prefix.slice(c.prefix.lastIndexOf("\n") + 1);
  // Cursor in the middle of an identifier (the next character continues a word): wait until the word is finished.
  if (/\w$/.test(lineStart) && /^\w/.test(c.suffix)) return false;
  return true;
}
