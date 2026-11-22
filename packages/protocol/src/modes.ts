import type { Mode, ToolClass } from "./index";

/** Tool classes the tool host may expose per mode (section 6.1). Enforced by the host, not the prompt. */
export const MODE_TOOL_CLASSES: Record<Mode, readonly ToolClass[]> = {
  ask: ["read"],
  plan: ["read"], // plus writes to the plan file only, handled by the host in Phase 6
  agent: ["read", "write", "execute", "network"],
  debug: ["read", "write", "execute", "network"],
};
