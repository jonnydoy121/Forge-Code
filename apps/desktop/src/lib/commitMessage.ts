/**
 * Models wrap commit messages in all sorts of decoration: a code fence, backticks, quotes, a "Commit message:" label, a markdown
 * heading marker (a leading # is a comment to git). This keeps just the message.
 */
export function cleanCommitMessage(raw: string): string {
  let t = raw.replace(/\r\n?/g, "\n").trim();
  // A fenced block: keep what is inside the first fence.
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```/m.exec(t);
  if (fenced) t = fenced[1]!.trim();
  // A label in front: "Commit message:", "Subject -", ...
  t = t.replace(/^(?:here(?:'s| is) (?:the |a )?)?(?:commit message|subject|message)\s*[:-]\s*/i, "");
  // Wrapped as a whole in backticks or quotes.
  for (let i = 0; i < 2; i++) {
    const m = /^(`+|"|')([\s\S]+)\1$/.exec(t);
    if (m) t = m[2]!.trim();
  }
  // A markdown heading marker on the first line.
  t = t.replace(/^#{1,6}\s+/, "");
  return t.trim();
}
