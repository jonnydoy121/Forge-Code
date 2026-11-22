import { globToRegExp, type HookEvent } from "@forge/protocol";
import type { Exec } from "./exec";
import { tail } from "./parsers";

export const HOOK_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "PostEdit", "Stop", "PreCompact", "PostCompact", "SessionStart"];

export interface HookSpec {
  command: string;
  /** glob matched against the tool name (Pre/PostToolUse) or the file path (PostEdit). Omit to match everything. */
  matcher?: string;
  timeoutMs?: number;
}

export type HooksConfig = Partial<Record<HookEvent, HookSpec[]>>;

/** Parse .forge/hooks.json: `{ "PostEdit": [{ "command": "prettier --write \"$FORGE_FILE\"", "matcher": "*.ts" }] }`. */
export function parseHooksConfig(text: string | null): { config: HooksConfig; errors: string[] } {
  const errors: string[] = [];
  if (!text) return { config: {}, errors };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { config: {}, errors: [`.forge/hooks.json is not valid JSON: ${(e as Error).message}`] };
  }
  const config: HooksConfig = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { config, errors: [".forge/hooks.json must be an object keyed by event name"] };
  for (const [event, specs] of Object.entries(raw as Record<string, unknown>)) {
    if (!HOOK_EVENTS.includes(event as HookEvent)) {
      errors.push(`unknown hook event "${event}" (valid: ${HOOK_EVENTS.join(", ")})`);
      continue;
    }
    if (!Array.isArray(specs)) {
      errors.push(`hooks for ${event} must be an array`);
      continue;
    }
    config[event as HookEvent] = specs.flatMap((s, i) => {
      if (typeof s !== "object" || s === null || typeof (s as HookSpec).command !== "string" || !(s as HookSpec).command.trim()) {
        errors.push(`${event}[${i}] needs a non-empty "command"`);
        return [];
      }
      const h = s as HookSpec;
      return [{ command: h.command, matcher: typeof h.matcher === "string" ? h.matcher : undefined, timeoutMs: typeof h.timeoutMs === "number" ? h.timeoutMs : undefined }];
    });
  }
  return { config, errors };
}

export interface HookContext {
  tool?: string;
  /** workspace-relative path(s) involved */
  files?: string[];
  /** extra values exposed to the hook as FORGE_* variables */
  extra?: Record<string, string>;
}

export interface HookOutcome {
  ran: number;
  /** A hook exited with code 2: the action must not proceed (Pre hooks), or the agent must address the output (Post hooks, Stop). */
  blocked: boolean;
  /** Combined, truncated hook output to feed back to the agent. */
  output: string;
}

/**
 * Runs developer-configured lifecycle hooks. A hook is a shell command; context is passed through FORGE_*
 * environment variables (never interpolated into the command line, so file names cannot inject shell syntax).
 * Exit 0 = ok, exit 2 = block, anything else = a warning that is shown but does not block.
 */
export class HookRunner {
  constructor(private cfg: { config: HooksConfig; exec: Exec; cwd: string }) {}

  get config() {
    return this.cfg.config;
  }

  async run(event: HookEvent, ctx: HookContext = {}): Promise<HookOutcome> {
    const specs = (this.cfg.config[event] ?? []).filter((s) => {
      if (!s.matcher) return true;
      const re = globToRegExp(s.matcher);
      const subjects = event.endsWith("ToolUse") ? [ctx.tool ?? ""] : ctx.files ?? [];
      return subjects.some((x) => re.test(x));
    });
    const outcome: HookOutcome = { ran: 0, blocked: false, output: "" };
    const parts: string[] = [];
    for (const s of specs) {
      const env: Record<string, string> = {
        FORGE_EVENT: event,
        FORGE_TOOL: ctx.tool ?? "",
        FORGE_FILE: ctx.files?.[0] ?? "",
        FORGE_FILES: (ctx.files ?? []).join("\n"),
        ...ctx.extra,
      };
      const r = await this.cfg.exec.run(s.command, { cwd: this.cfg.cwd, timeoutMs: s.timeoutMs ?? 60_000, env });
      outcome.ran++;
      const out = tail(`${r.stdout}\n${r.stderr}`, 1000);
      if (r.timedOut) parts.push(`[hook "${s.command}" timed out]`);
      else if (r.code === 2) {
        outcome.blocked = true;
        parts.push(out || `[hook "${s.command}" blocked this action]`);
      } else if (r.code !== 0) parts.push(`[hook "${s.command}" exited ${r.code}] ${out}`);
      else if (out) parts.push(out);
    }
    outcome.output = parts.join("\n");
    return outcome;
  }
}
