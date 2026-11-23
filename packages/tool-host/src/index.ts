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

/** A glob without a slash matches by name anywhere in the tree (`*.ts`), like ripgrep and the indexer; with a slash it is anchored. */
const workspaceGlob = (g: string): { test(rel: string): boolean } => {
  const res = expandBraces(g.includes("/") ? g : `**/${g}`).map(globToRegExp);
  return { test: (rel) => res.some((re) => re.test(rel)) };
};

/** `*.{ts,py}` as `*.ts` and `*.py` (one level of braces per pass, so nested groups work too). */
function expandBraces(g: string): string[] {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m) return [g];
  return m[1]!.split(",").flatMap((alt) => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
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
    description: "Search workspace files for a regular expression. Optional glob filters paths (e.g. src/**/*.ts or *.py). Set ignore_case for a case-insensitive search and files_only to list just the matching file paths. Returns path:line:text.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" }, ignore_case: { type: "boolean" }, files_only: { type: "boolean" } }, required: ["pattern"] },
    class: "read",
  },
  async run(args, ctx) {
    const re = new RegExp(str(args.pattern, "pattern"), args.ignore_case === true ? "i" : "");
    const glob = typeof args.glob === "string" && args.glob ? workspaceGlob(args.glob) : null;
    const filesOnly = args.files_only === true;
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
          hits.push(filesOnly ? rel : `${rel}:${i + 1}:${lines[i]!.trim().slice(0, 200)}`);
          if (filesOnly) {
            if (hits.length >= MAX_GREP_MATCHES) return truncate(redactSecrets(hits.join("\n") + `\n[stopped at ${MAX_GREP_MATCHES} files]`));
            break; // one matching line is enough to list the file
          }
          if (hits.length >= MAX_GREP_MATCHES) return truncate(redactSecrets(hits.join("\n") + `\n[stopped at ${MAX_GREP_MATCHES} matches]`));
        }
      }
    }
    return hits.length ? truncate(redactSecrets(hits.join("\n"))) : "no matches";
  },
};

/** Same matching rule as the indexer's `find_files`: a pattern with glob characters is a glob, anything else a case-insensitive substring of the path. */
export function pathMatcher(pattern: string): (rel: string) => boolean {
  if (/[*?[{]/.test(pattern)) {
    const re = workspaceGlob(pattern);
    return (rel) => re.test(rel);
  }
  const needle = pattern.toLowerCase();
  return (rel) => rel.toLowerCase().includes(needle);
}

export const findFilesTool: RegisteredTool = {
  spec: {
    name: "find_files",
    description: "Find files by name. A pattern with * ? or {a,b} is a glob (*.test.ts matches anywhere, src/**/*.ts is anchored); anything else is a case-insensitive part of the path (auth finds src/auth/login.ts). Returns sorted workspace paths.",
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    class: "read",
  },
  async run(args, ctx) {
    const match = pathMatcher(str(args.pattern, "pattern"));
    const found: string[] = [];
    for await (const file of walk(ctx, resolveInRoot(ctx.root, "."))) {
      const rel = relativeTo(ctx.root, file);
      if (isSecretPath(file) || !match(rel)) continue;
      found.push(rel);
      if (found.length >= MAX_GREP_MATCHES) return found.join("\n") + `\n[stopped at ${MAX_GREP_MATCHES} files]`;
    }
    return found.length ? truncate(found.join("\n")) : "no files found";
  },
};

export const READ_TOOLS = [readFileTool, lsTool, grepTool, findFilesTool];

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
