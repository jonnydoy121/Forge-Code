import type { Checkpoint, CheckpointStore } from "@forge/protocol";

export class InMemoryCheckpointStore implements CheckpointStore {
  private items: Checkpoint[] = [];
  async snapshot(files: string[], meta: { step?: number } = {}) {
    const cp: Checkpoint = { id: `cp-${this.items.length + 1}`, files, step: meta.step, createdAt: Date.now() };
    this.items.push(cp);
    return cp;
  }
  async restore(id: string) {
    if (!this.items.some((c) => c.id === id)) throw new Error(`unknown checkpoint ${id}`);
  }
  async list() {
    return [...this.items];
  }
}
