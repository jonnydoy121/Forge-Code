import type { Message } from "@forge/protocol";
import type { MemoryFs } from "./memory";

export interface SessionRecord {
  id: string;
  savedAt: string;
  messages: Message[];
  /** compaction summaries so far, for display */
  summaries: string[];
}

/** Session transcripts as readable JSON files under .forge/sessions. */
export class SessionStore {
  constructor(private fs: MemoryFs, private dir: string) {}

  async save(rec: SessionRecord): Promise<void> {
    await this.fs.write(`${this.dir}/${rec.id}.json`, JSON.stringify(rec, null, 1));
  }

  async load(id: string): Promise<SessionRecord | null> {
    const t = await this.fs.read(`${this.dir}/${id}.json`);
    if (!t) return null;
    try {
      return JSON.parse(t) as SessionRecord;
    } catch {
      return null;
    }
  }

  async latest(): Promise<SessionRecord | null> {
    const names = (await this.fs.list(this.dir)).filter((n) => n.endsWith(".json"));
    let best: SessionRecord | null = null;
    for (const n of names) {
      const r = await this.load(n.slice(0, -5));
      if (r && (!best || r.savedAt > best.savedAt)) best = r;
    }
    return best;
  }
}

const STOP = new Set("the a an and or to of in on for with is are be this that it as at by from can you i we please make add use do not now then also just".split(" "));
const toks = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP.has(w)));

/** Jaccard similarity of the content words of two messages. */
export function taskSimilarity(a: string, b: string): number {
  const A = toks(a);
  const B = toks(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Should Forge suggest a fresh thread? The task changed after a few turns of something else. */
export function suggestNewThread(previousPrompts: string[], next: string): boolean {
  if (previousPrompts.length < 3 || next.trim().length < 25) return false;
  const recent = previousPrompts.slice(-3);
  return Math.max(...recent.map((p) => taskSimilarity(p, next))) < 0.08;
}
