import type { Mode, ToolCall, ToolHost, ToolResult } from "@forge/protocol";
import { MODE_TOOL_CLASSES } from "@forge/protocol/src/modes";

const TOOLS = [{ name: "read_file", class: "read" as const }, { name: "write_file", class: "write" as const }, { name: "run_command", class: "execute" as const }];

export class StubToolHost implements ToolHost {
  listTools(mode: Mode) {
    return TOOLS.filter((t) => MODE_TOOL_CLASSES[mode].includes(t.class));
  }
  async call(mode: Mode, call: ToolCall): Promise<ToolResult> {
    if (!this.listTools(mode).some((t) => t.name === call.name)) {
      return { id: call.id, ok: false, output: `tool ${call.name} not available in ${mode} mode` };
    }
    return { id: call.id, ok: true, output: "" };
  }
}
