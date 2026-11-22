import type { Mode, ToolClass } from "./index";

/** Tool classes the tool host may expose per mode (section 6.1). Enforced by the host, not the prompt. */
export const MODE_TOOL_CLASSES: Record<Mode, readonly ToolClass[]> = {
  ask: ["read"],
  plan: ["read", "plan"], // the plan file only; the plan tool itself refuses any other path
  agent: ["read", "write", "execute", "network", "plan"],
  debug: ["read", "write", "execute", "network", "plan"],
};
