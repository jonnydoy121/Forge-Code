import { asString, parseFrontmatter, stringifyFrontmatter } from "./frontmatter";

export interface MemoryFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(dir: string): Promise<string[]>;
}

export type MemoryScope = "project" | "user";

export interface Memory {
  id: string;
  scope: MemoryScope;
  name: string;
  description: string;
  body: string;
  created: string;
  path: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "memory";

export interface MemoryDirs {
  /** <root>/.forge/memory (can be committed) */
  project: string;
  /** a directory in the user profile (personal), if available */
  user?: string;
}

/** Memories are plain Markdown files the developer can read, edit and delete. Nothing is stored silently. */
export class MemoryStore {
  constructor(
    private fs: MemoryFs,
    private dirs: MemoryDirs,
    private onChange?: () => void,
    private today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  private dir(scope: MemoryScope) {
    const d = scope === "user" ? this.dirs.user : this.dirs.project;
    if (!d) throw new Error("no user memory directory is available");
    return d;
  }

  async list(): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const scope of ["project", "user"] as const) {
      const dir = scope === "user" ? this.dirs.user : this.dirs.project;
      if (!dir) continue;
      for (const n of (await this.fs.list(dir)).filter((x) => x.endsWith(".md")).sort()) {
        const text = await this.fs.read(`${dir}/${n}`);
        if (text === null) continue;
        const { data, body } = parseFrontmatter(text);
        const id = n.slice(0, -3);
        out.push({ id: `${scope}:${id}`, scope, name: asString(data.name) ?? id, description: asString(data.description) ?? "", body: body.trim(), created: asString(data.created) ?? "", path: `${dir}/${n}` });
      }
    }
    return out;
  }

  async save(m: { name: string; description?: string; body: string; scope: MemoryScope }): Promise<Memory> {
    const dir = this.dir(m.scope);
    const existing = new Set((await this.fs.list(dir)).map((x) => x.replace(/\.md$/, "")));
    let id = slug(m.name);
    for (let i = 2; existing.has(id); i++) id = `${slug(m.name)}-${i}`;
    const path = `${dir}/${id}.md`;
    const created = this.today();
    await this.fs.write(path, stringifyFrontmatter({ name: m.name, description: m.description ?? "", scope: m.scope, created }, m.body.trim() + "\n"));
    this.onChange?.();
    return { id: `${m.scope}:${id}`, scope: m.scope, name: m.name, description: m.description ?? "", body: m.body.trim(), created, path };
  }

  async update(memory: Memory, patch: { name?: string; description?: string; body?: string }): Promise<void> {
    await this.fs.write(memory.path, stringifyFrontmatter({ name: patch.name ?? memory.name, description: patch.description ?? memory.description, scope: memory.scope, created: memory.created }, (patch.body ?? memory.body).trim() + "\n"));
    this.onChange?.();
  }

  async remove(memory: Memory): Promise<void> {
    await this.fs.remove(memory.path);
    this.onChange?.();
  }

  async search(query: string): Promise<Memory[]> {
    const q = query.trim().toLowerCase();
    const all = await this.list();
    return q ? all.filter((m) => `${m.name} ${m.description} ${m.body}`.toLowerCase().includes(q)) : all;
  }
}

const STOP = new Set("the a an and or to of in on for with is are be this that it as at by from use using do not don't can you i we please make add".split(" "));
const words = (s: string) => (s.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP.has(w));

/** Pick the memories relevant to this request. Small sets are included whole. */
export function selectMemories(memories: Memory[], prompt: string, opts: { maxChars?: number; limit?: number } = {}): Memory[] {
  const maxChars = opts.maxChars ?? 4000;
  const total = memories.reduce((n, m) => n + m.body.length + m.name.length, 0);
  if (total <= maxChars) return memories;
  const q = new Set(words(prompt));
  const scored = memories.map((m) => ({ m, s: words(`${m.name} ${m.description} ${m.body}`).filter((w) => q.has(w)).length })).sort((a, b) => b.s - a.s || a.m.name.localeCompare(b.m.name));
  const out: Memory[] = [];
  let chars = 0;
  for (const { m, s } of scored) {
    if (s === 0 && out.length >= (opts.limit ?? 5)) break;
    if (chars + m.body.length > maxChars) continue;
    out.push(m);
    chars += m.body.length;
  }
  return out;
}

export function renderMemories(ms: Memory[]): string {
  return ms.map((m) => `- ${m.name}${m.description ? ` (${m.description})` : ""}: ${m.body.replace(/\n+/g, " ")}`).join("\n");
}

export interface Correction {
  /** a suggested memory body drawn from the message */
  text: string;
  /** a short suggested name */
  name: string;
}

const CORRECTION = /\b(?:always|never|from now on|stop (?:doing|using|adding)|don'?t (?:ever )?(?:use|add|write|do|put)|do not (?:use|add|write|do)|prefer|use .{2,40} instead(?: of)?|instead of|remember (?:that|to)|make sure (?:you|to)|you should (?:always|never)|we (?:always|never|prefer|use))\b/i;

/** Detect "always use async/await here" style corrections so Forge can offer (never silently perform) saving them. */
export function detectCorrection(message: string): Correction | null {
  const t = message.trim();
  if (t.length < 12 || t.length > 400) return null;
  if (/\?\s*$/.test(t) && !/^(?:always|never)\b/i.test(t)) return null; // a question, not an instruction
  if (!CORRECTION.test(t)) return null;
  const text = t.replace(/\s+/g, " ");
  const name = words(text).slice(0, 4).join("-") || "preference";
  return { text, name };
}
