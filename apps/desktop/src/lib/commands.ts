export interface Command {
  id: string;
  title: string;
  keybinding?: string;
  run: () => void;
}

/** Subsequence fuzzy match. Returns a score (higher is better) or null when the query does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += found === prev + 1 ? 3 : 1; // consecutive characters score higher
    if (found === 0 || t[found - 1] === " ") score += 2; // word starts score higher
    prev = found;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

export function filterCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) return commands;
  return commands
    .map((c) => ({ c, s: fuzzyScore(query.trim(), c.title) }))
    .filter((x): x is { c: Command; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

/** Does a keyboard event match a binding like "Ctrl+Shift+P"? Ctrl also matches Cmd. */
export function matchesKeybinding(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  return (
    e.key.toLowerCase() === key &&
    (e.ctrlKey || e.metaKey) === parts.includes("ctrl") &&
    e.shiftKey === parts.includes("shift") &&
    e.altKey === parts.includes("alt")
  );
}
