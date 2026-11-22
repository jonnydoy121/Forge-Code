import type { ContextStore } from "@forge/protocol";

export class EmptyContextStore implements ContextStore {
  async rulesFor() { return []; }
}
