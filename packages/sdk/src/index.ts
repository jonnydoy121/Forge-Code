// @forge/sdk: typed helpers for the two things you can write yourself.
//
//  1. A custom tool: a script in `.forge/skills/<skill>/` that the agent can call. Forge-Code starts it in the workspace root with ONE
//     command-line argument, the path of a JSON file holding the arguments. Declare it in the skill's `tools.json` so the agent sees a
//     description and the arguments are checked before the script runs.
//  2. A lifecycle hook: a command in `.forge/hooks.json`. Forge-Code passes context as FORGE_* environment variables. Exit 0 = fine,
//     exit 2 = block the action (or send the output back to the agent), any other code = a warning.
//
// No dependencies besides Node, so this one file can be copied next to a script as well as imported.
import { readFileSync } from "node:fs";

// ---------- custom tools ----------
export interface ParamSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, ParamSchema>;
  required?: string[];
  enum?: (string | number | boolean)[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

export interface ToolDef {
  description: string;
  parameters?: ParamSchema;
  /** Returns the text the agent sees. An object is shown as JSON. Throw to report an error. */
  run(args: Record<string, unknown>, ctx: { cwd: string }): string | object | Promise<string | object>;
}

export const defineTool = (def: ToolDef): ToolDef => def;

/** The `tools.json` for a skill: `{ "bump.js": defineTool({...}) }` becomes the file's text. */
export function toolsManifest(tools: Record<string, ToolDef>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(tools).map(([file, t]) => [file, { description: t.description, parameters: t.parameters }])), null, 2);
}

export interface ProcessIo {
  argv: string[];
  cwd: string;
  out(text: string): void;
  err(text: string): void;
}
const realIo = (): ProcessIo => ({ argv: process.argv, cwd: process.cwd(), out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t) });

/** Run a tool the way Forge-Code starts it: read the JSON argument file named by argv[2], print the result. Returns the exit code. */
export async function runTool(tool: ToolDef, io: ProcessIo = realIo()): Promise<number> {
  let args: Record<string, unknown> = {};
  const file = io.argv[2];
  if (file) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch (e) {
      io.err(`could not read the arguments file: ${(e as Error).message}\n`);
      return 1;
    }
  }
  try {
    const result = await tool.run(args, { cwd: io.cwd });
    io.out(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

// ---------- lifecycle hooks ----------
export type HookEventName = "PreToolUse" | "PostToolUse" | "PostEdit" | "Stop" | "PreCompact" | "PostCompact" | "SessionStart";

export interface HookInput {
  event: HookEventName | string;
  /** the tool being called (PreToolUse and PostToolUse) */
  tool: string;
  /** the first file involved, workspace-relative */
  file: string;
  files: string[];
  /** the tool's arguments as JSON text (PreToolUse); parsed when it is valid JSON */
  toolArgs: unknown;
}

export function hookInput(env: Record<string, string | undefined> = process.env): HookInput {
  let toolArgs: unknown = undefined;
  if (env.FORGE_TOOL_ARGS) {
    try {
      toolArgs = JSON.parse(env.FORGE_TOOL_ARGS);
    } catch {
      toolArgs = env.FORGE_TOOL_ARGS; // cut off at 2000 characters by Forge-Code, so not always valid JSON
    }
  }
  return { event: env.FORGE_EVENT ?? "", tool: env.FORGE_TOOL ?? "", file: env.FORGE_FILE ?? "", files: (env.FORGE_FILES ?? "").split("\n").filter(Boolean), toolArgs };
}

/** What a hook returns: nothing or text (fine), or `{ block }` to stop the action and tell the agent why. */
export type HookResult = void | string | { block: string };

export async function runHook(hook: (input: HookInput) => HookResult | Promise<HookResult>, env: Record<string, string | undefined> = process.env, io: ProcessIo = realIo()): Promise<number> {
  try {
    const r = await hook(hookInput(env));
    if (r && typeof r === "object") {
      io.out(r.block);
      return 2;
    }
    if (typeof r === "string") io.out(r);
    return 0;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
