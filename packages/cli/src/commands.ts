// Command execution for the headless CLI. With no human to approve commands, nothing runs unless the caller listed it
// with --allow. Wildcard matches cannot chain further commands, and the catastrophic-command deny list always applies.

import { createCommandTools } from "@forge/verify";
import { nodeExec } from "@forge/verify/src/node-exec";
import { denyReason } from "@forge/safety";
import type { RegisteredTool } from "@forge/tool-host";

/** Characters that let one shell command run another or redirect output. */
const CHAINING = /[;&|<>`$()\n\r]/;

/** Exact match, or a trailing `*` for a prefix match. Prefix matches may not chain or redirect. */
export function isAllowed(command: string, patterns: string[]): boolean {
  const cmd = command.trim();
  return patterns.some((raw) => {
    const p = raw.trim();
    if (!p) return false;
    if (p.endsWith("*")) return cmd.startsWith(p.slice(0, -1).trimEnd()) && !CHAINING.test(cmd.slice(p.slice(0, -1).trimEnd().length));
    return cmd === p;
  });
}

export function headlessCommandTools(cwd: string, allow: string[], audit?: (line: string) => void): RegisteredTool[] {
  const base = createCommandTools({ exec: nodeExec, cwd, sandbox: () => true, audit: (e) => audit?.(`${e.name}${e.detail ? ` (${e.detail})` : ""}`) });
  return base
    .filter((t) => t.spec.name === "run_command") // no background processes in headless mode
    .map((t) => ({
      spec: {
        ...t.spec,
        // The stock text promises an OS sandbox; the CLI only scrubs the environment, so say exactly that.
        description: `Run a shell command in the workspace and return its output. Only these commands are permitted: ${allow.map((a) => JSON.stringify(a)).join(", ")} (a trailing * allows any arguments, but never chained or redirected commands). Anything else is refused. The command runs with a scrubbed environment (no secrets) but without an OS sandbox.`,
      },
      async run(args, ctx) {
        const command = typeof args.command === "string" ? args.command.trim() : "";
        const danger = denyReason(command);
        if (danger) throw new Error(`refused: ${danger}. This is blocked even when allowed.`);
        if (!isAllowed(command, allow)) throw new Error(`refused: this command is not on the allowlist. Permitted: ${allow.join(" | ")}`);
        return t.run(args, ctx);
      },
    }));
}
