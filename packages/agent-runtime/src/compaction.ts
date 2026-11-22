import type { Message, ModelGateway } from "@forge/protocol";

const SUMMARY_PROMPT = `You are compressing an AI coding session so it can continue in a smaller context. Write a faithful summary of the conversation below.
Keep, in this order:
1. The user's goals and any constraints or preferences they stated.
2. Decisions made, and the reasons.
3. Open decisions and unresolved questions (list them verbatim under "Open decisions").
4. What has been done so far, and what remains.
5. Anything learned about the codebase that will be needed again (file paths, symbol names, commands).
If the transcript already contains an earlier summary, fold its content in; do not lose it. Be concrete and brief (under 400 words). Do not invent anything.`;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " [...]" : s);

/** Plain-text transcript for the summariser. Tool output is shortened: the summary needs the gist, not the bytes. */
export function transcriptOf(messages: Message[], maxChars = 30_000): string {
  const lines = messages.map((m) => {
    if (m.role === "tool") return `[tool result] ${clip(m.content, 400)}`;
    const calls = m.toolCalls?.length ? ` [called ${m.toolCalls.map((c) => `${c.name}(${clip(JSON.stringify(c.args), 120)})`).join(", ")}]` : "";
    return `[${m.role}] ${clip(m.content, 1500)}${calls}`;
  });
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars / 2) + "\n[... middle of the transcript omitted ...]\n" + text.slice(-maxChars / 2);
  return text;
}

/** File paths the conversation has read or edited, kept verbatim through compaction. */
export function filesTouchedIn(messages: Message[]): string[] {
  const files = new Set<string>();
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      const p = c.args.path ?? c.args.file;
      if (typeof p === "string") files.add(p);
    }
    // a previous compaction block lists files; carry them forward
    const prev = /Files read or changed so far: (.*)$/m.exec(m.content);
    if (prev) for (const f of prev[1]!.split(", ")) files.add(f.trim());
  }
  return [...files].sort();
}

export const SUMMARY_MARKER = "[Summary of the earlier conversation, produced by Forge to save context]";

/** Summarise with the same model, no tools. */
export async function summarizeWith(gateway: ModelGateway, provider: string, model: string, messages: Message[], extraInstructions = ""): Promise<string> {
  let text = "";
  for await (const ev of gateway.stream({
    provider,
    model,
    messages: [
      { role: "system", content: SUMMARY_PROMPT + (extraInstructions ? `\nAlso: ${extraInstructions}` : "") },
      { role: "user", content: transcriptOf(messages) },
    ],
    tools: [],
  })) {
    if (ev.type === "text") text += ev.delta;
  }
  return text.trim();
}

/**
 * Index at which to cut the history: everything before it is summarised, everything from it on is kept verbatim.
 * Always a user message (never in the middle of a tool call and its results), leaving about `keepRecent` messages.
 */
export function compactionCut(history: Message[], keepRecent: number): number {
  for (let i = Math.min(history.length - keepRecent, history.length - 1); i > 0; i--) {
    if (history[i]!.role === "user" && !history[i]!.content.startsWith(SUMMARY_MARKER)) return i;
  }
  return 0;
}
