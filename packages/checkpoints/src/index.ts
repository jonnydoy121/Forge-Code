import type { Checkpoint, CheckpointMeta, CheckpointStore, RollbackSelector } from "@forge/protocol";
import { applyHunks, diffHunks, joinLines, splitLines } from "@forge/review";

/** Workspace file access for snapshots and restores. `null` means "file does not exist". Paths are absolute. */
export interface CheckpointFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Names (not paths) of entries in a directory; empty if it does not exist. */
  list(dir: string): Promise<string[]>;
}

interface Stored extends Checkpoint {
  /** Content of each file before the edit; null if the file did not exist. */
  before: Record<string, string | null>;
}

export interface StoreOptions {
  fs: CheckpointFs;
  /** Directory holding this session's checkpoints, e.g. <root>/.forge/checkpoints/<session>. */
  dir: string;
  /** Oldest checkpoints are pruned beyond this count. The spec requires keeping at least 100. */
  max?: number;
  now?: () => number;
}

const pad = (n: number) => String(n).padStart(5, "0");

/** Snapshots files before agent edits and restores them by checkpoint, step, change set, file or hunk. Independent of git. */
export class FileCheckpointStore implements CheckpointStore {
  private items: Stored[] = [];
  private seq = 0;
  private max: number;
  private loaded = false;

  constructor(private opts: StoreOptions) {
    this.max = Math.max(100, opts.max ?? 500);
  }

  /** Load persisted checkpoints (survives restarts). */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const names = (await this.opts.fs.list(this.opts.dir)).filter((n) => /^cp-\d+\.json$/.test(n)).sort();
    for (const n of names) {
      const raw = await this.opts.fs.read(`${this.opts.dir}/${n}`);
      if (!raw) continue;
      try {
        const cp = JSON.parse(raw) as Stored;
        this.items.push(cp);
        this.seq = Math.max(this.seq, Number(n.slice(3, -5)));
      } catch {
        /* skip a corrupt checkpoint file rather than losing the whole timeline */
      }
    }
  }

  async snapshot(files: string[], meta: CheckpointMeta = {}): Promise<Checkpoint> {
    await this.load();
    const before: Record<string, string | null> = {};
    for (const f of [...new Set(files)]) before[f] = await this.opts.fs.read(f);
    const id = `cp-${pad(++this.seq)}`;
    const cp: Stored = { id, files: Object.keys(before), createdAt: (this.opts.now ?? Date.now)(), ...meta, before };
    this.items.push(cp);
    await this.opts.fs.write(`${this.opts.dir}/${id}.json`, JSON.stringify(cp));
    await this.prune();
    const { before: _b, ...pub } = cp;
    void _b;
    return pub;
  }

  private async prune() {
    while (this.items.length > this.max) {
      const old = this.items.shift()!;
      await this.opts.fs.remove(`${this.opts.dir}/${old.id}.json`);
    }
  }

  async list(): Promise<Checkpoint[]> {
    await this.load();
    return this.items.map(({ before: _b, ...pub }) => (void _b, pub));
  }

  private find(id: string): Stored {
    const cp = this.items.find((c) => c.id === id);
    if (!cp) throw new Error(`unknown checkpoint ${id}`);
    return cp;
  }

  private async put(path: string, content: string | null) {
    if (content === null) await this.opts.fs.remove(path);
    else await this.opts.fs.write(path, content);
  }

  /** Restore the files of one checkpoint to their pre-edit content. */
  async restore(id: string, opts: { file?: string } = {}) {
    await this.load();
    const cp = this.find(id);
    const files = opts.file ? [opts.file] : cp.files;
    await this.snapshot(files, { label: `before restoring ${id}` });
    for (const f of files) {
      if (!(f in cp.before)) throw new Error(`${f} is not part of ${id}`);
      await this.put(f, cp.before[f]!);
    }
  }

  /**
   * Roll back every matching checkpoint: each affected file returns to its content before the earliest matching
   * edit. Returns the files restored. A "before rollback" checkpoint is taken first, so a rollback can be undone.
   */
  async rollback(sel: RollbackSelector): Promise<string[]> {
    await this.load();
    let matching = this.items;
    if (sel.toCheckpoint) {
      const idx = this.items.findIndex((c) => c.id === sel.toCheckpoint);
      if (idx < 0) throw new Error(`unknown checkpoint ${sel.toCheckpoint}`);
      matching = this.items.slice(idx);
    }
    if (sel.changeSet !== undefined) matching = matching.filter((c) => c.changeSet === sel.changeSet);
    if (sel.step !== undefined) matching = matching.filter((c) => c.step === sel.step);
    const target = new Map<string, string | null>();
    for (const cp of matching) {
      for (const f of cp.files) {
        if (sel.file && f !== sel.file) continue;
        if (!target.has(f)) target.set(f, cp.before[f]!); // earliest wins
      }
    }
    if (target.size === 0) return [];
    await this.snapshot([...target.keys()], { label: "before rollback" });
    for (const [f, content] of target) await this.put(f, content);
    return [...target.keys()].sort();
  }

  /**
   * Undo one hunk of the change recorded by `checkpointId`: diff the file's pre-edit content against its current
   * content and re-apply every hunk except the chosen one. Fails if the file no longer exists.
   */
  async rollbackHunk(checkpointId: string, file: string, hunkId: string): Promise<void> {
    await this.load();
    const cp = this.find(checkpointId);
    if (!(file in cp.before)) throw new Error(`${file} is not part of ${checkpointId}`);
    const before = cp.before[file] ?? "";
    const current = await this.opts.fs.read(file);
    if (current === null) throw new Error(`${file} no longer exists`);
    const hunks = diffHunks(splitLines(before), splitLines(current));
    if (!hunks.some((h) => h.id === hunkId)) throw new Error(`hunk ${hunkId} not found; the file changed since ${checkpointId}`);
    await this.snapshot([file], { label: "before hunk rollback" });
    await this.opts.fs.write(file, joinLines(applyHunks(splitLines(before), hunks, (h) => h.id !== hunkId)));
  }

  /** Hunks between a checkpoint's pre-edit content and the file now (for the per-hunk rollback UI). */
  async hunksSince(checkpointId: string, file: string) {
    await this.load();
    const cp = this.find(checkpointId);
    const current = (await this.opts.fs.read(file)) ?? "";
    return diffHunks(splitLines(cp.before[file] ?? ""), splitLines(current));
  }
}

/** In-memory CheckpointFs for tests and the stub store. */
export class MemoryFs implements CheckpointFs {
  files = new Map<string, string>();
  async read(p: string) {
    return this.files.get(p) ?? null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async list(dir: string) {
    const prefix = dir.replace(/\/$/, "") + "/";
    return [...this.files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => k.slice(prefix.length));
  }
}

/** Kept for the Phase 0 contract test and as a trivial store. */
export class InMemoryCheckpointStore extends FileCheckpointStore {
  constructor() {
    super({ fs: new MemoryFs(), dir: "/cp" });
  }
}
