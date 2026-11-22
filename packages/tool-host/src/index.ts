import {
  MODE_TOOL_CLASSES,
  globToRegExp,
  isIgnoredDir,
  isSecretPath,
  redactSecrets,
  relativeTo,
  resolveInRoot,
  type Mode,
  type ToolCall,
  type ToolHost,
  type ToolResult,
  type ToolSpec,
  type TouchedFile,
} from "@forge/protocol";

export interface FsEntry { name: string; isDir: boolean }

/** Filesystem access the tool host needs. Implemented over Node fs in tests and over Tauri IPC in the app. */
export interface FsBackend {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<FsEntry[]>;
  /** Optional write support (Phase 4). Absent = read-only backend. */
  writeFile?(path: string, contents: string): Promise<void>;
}

export interface ToolContext {
  root: string;
  fs: FsBackend;
}

export interface RegisteredTool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string | { output: string; touched?: TouchedFile[] }>;
}

export const MAX_OUTPUT_CHARS = 20_000;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 1_000_000;

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`missing required argument: ${name}`);
  return v;
};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + `\n[truncated ${s.length - MAX_OUTPUT_CHARS} chars]` : s;
}

async function* walk(ctx: ToolContext, dir: string): AsyncIterable<string> {
  const entries = await ctx.fs.readdir(dir).catch(() => []);
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = `${dir}/${e.name}`;
    if (e.isDir) {
      if (!isIgnoredDir(e.name)) yield* walk(ctx, p);
    } else yield p;
  }
}

export const readFileTool: RegisteredTool = {
  spec: {
    name: "read_file",
    description: "Read a text file in the workspace. Optionally restrict to a 1-based inclusive line range. Output is line-numbered.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, start_line: { type: "number" }, end_line: { type: "number" } },
      required: ["path"],
    },
    class: "read",
  },
  async run(args, ctx) {
    const path = resolveInRoot(ctx.root, str(args.path, "path"));
    if (isSecretPath(path)) throw new Error("refusing to read a file that looks like it holds secrets");
    const lines = (await ctx.fs.readFile(path)).split("\n");
    const start = Math.max(1, num(args.start_line) ?? 1);
    const end = Math.min(lines.length, num(args.end_line) ?? lines.length);
    return truncate(redactSecrets(lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join("\n")));
  },
};

export const lsTool: RegisteredTool = {
  spec: {
    name: "ls",
    description: "List a directory in the workspace (folders end with /).",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    class: "read",
  },
  async run(args, ctx) {
    const path = resolveInRoot(ctx.root, typeof args.path === "string" && args.path ? args.path : ".");
    const entries = await ctx.fs.readdir(path);
    return entries
      .filter((e) => !(e.isDir && isIgnoredDir(e.name)) && !isSecretPath(e.name))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
      .map((e) => e.name + (e.isDir ? "/" : ""))
      .join("\n");
  },
};

export const grepTool: RegisteredTool = {
  spec: {
    name: "grep",
    description: "Search workspace files for a regular expression. Optional glob filters paths (e.g. src/**/*.ts). Returns path:line:text.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] },
    class: "read",
  },
  async run(args, ctx) {
    const re = new RegExp(str(args.pattern, "pattern"));
    const glob = typeof args.glob === "string" && args.glob ? globToRegExp(args.glob) : null;
    const hits: string[] = [];
    for await (const file of walk(ctx, resolveInRoot(ctx.root, "."))) {
      const rel = relativeTo(ctx.root, file);
      if (isSecretPath(file) || (glob && !glob.test(rel))) continue;
      let text: string;
      try {
        text = await ctx.fs.readFile(file);
      } catch {
        continue; // unreadable or binary
      }
      if (text.length > MAX_GREP_FILE_BYTES) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${rel}:${i + 1}:${lines[i]!.trim().slice(0, 200)}`);
          if (hits.length >= MAX_GREP_MATCHES) return truncate(redactSecrets(hits.join("\n") + `\n[stopped at ${MAX_GREP_MATCHES} matches]`));
        }
      }
    }
    return hits.length ? truncate(redactSecrets(hits.join("\n"))) : "no matches";
  },
};

export const READ_TOOLS = [readFileTool, lsTool, grepTool];

export interface ToolHostOptions extends ToolContext {
  tools?: RegisteredTool[];
}

/**
 * The host enforces the mode: tools whose class the mode forbids are neither listed nor callable,
 * regardless of what the model asks for.
 */
export function createToolHost(opts: ToolHostOptions): ToolHost {
  const tools = new Map((opts.tools ?? READ_TOOLS).map((t) => [t.spec.name, t]));
  const allowed = (mode: Mode, t: RegisteredTool) => MODE_TOOL_CLASSES[mode].includes(t.spec.class);
  return {
    listTools: (mode) => [...tools.values()].filter((t) => allowed(mode, t)).map((t) => t.spec),
    async call(mode, call: ToolCall): Promise<ToolResult> {
      const tool = tools.get(call.name);
      if (!tool || !allowed(mode, tool)) {
        return { id: call.id, ok: false, output: `tool ${call.name} is not available in ${mode} mode` };
      }
      try {
        const r = await tool.run(call.args, opts);
        return typeof r === "string" ? { id: call.id, ok: true, output: r } : { id: call.id, ok: true, output: r.output, touched: r.touched };
      } catch (e) {
        return { id: call.id, ok: false, output: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export * from "./edit-tools";
