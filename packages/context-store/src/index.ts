import type { ContextStore } from "@forge/protocol";
import { RuleEngine } from "./rules";

export * from "./frontmatter";
export * from "./rules";
export * from "./lint";
export * from "./memory";
export * from "./docs";
export * from "./sessions";
export * from "./tools";

/** ContextStore contract over a RuleEngine: the protocol's `rulesFor(path)`. */
export class EngineContextStore implements ContextStore {
  constructor(private engine: RuleEngine) {}
  async rulesFor(path: string) {
    return (await this.engine.applicable([path])).map(RuleEngine.toProtocol);
  }
}

/** Empty store for tests and startup. */
export class EmptyContextStore implements ContextStore {
  rulesFor: ContextStore["rulesFor"] = async () => [];
}
