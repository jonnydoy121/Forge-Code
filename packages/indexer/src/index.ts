import { redactSecrets, type Indexer } from "@forge/protocol";
import type { RegisteredTool } from "@forge/tool-host";

/** Shape of the Rust indexer's results (see crates/forge-core/src/index). */
export interface GrepHit { file: string; line: number; text: string }
export interface SymbolHit { name: string; kind: string; file: string; line: number; end_line: number; signature: string; doc: string }
export interface RefHit { file: string; line: number; text: string; is_definition: boolean }
export interface ChunkHit { file: string; start: number; end: number; score: number; text: string }
export interface Cone { imports: string[]; imported_by: string[]; transitive_upstream: string[]; transitive_downstream: string[]; tests: string[] }

/** Transport to the indexer (Tauri IPC in the app, a fake in tests). Paths are workspace-relative. */
export interface IndexBackend {
  grep(pattern: string, glob?: string, max?: number): Promise<GrepHit[]>;
  symbol(name: string): Promise<SymbolHit[]>;
  references(symbol: string): Promise<RefHit[]>;
  repoMap(focusFiles: string[], tokenBudget: number): Promise<string>;
  semantic(query: string, k: number): Promise<ChunkHit[]>;
  cone(path: string): Promise<Cone>;
}

export class EmptyIndexer implements Indexer {
  grep: Indexer["grep"] = async () => [];
  symbol: Indexer["symbol"] = async () => undefined;
  references: Indexer["references"] = async () => [];
  repoMap: Indexer["repoMap"] = async () => "";
}

/** `Indexer` contract implemented over a backend. */
export class IndexClient implements Indexer {
  constructor(private b: IndexBackend) {}
  grep: Indexer["grep"] = (pattern, glob) => this.b.grep(pattern, glob);
  symbol: Indexer["symbol"] = async (name) => {
    const s = (await this.b.symbol(name))[0];
    return s && { name: s.name, file: s.file, line: s.line, kind: s.kind };
  };
  references: Indexer["references"] = async (symbol) =>
    (await this.b.references(symbol)).map((r) => ({ name: symbol, file: r.file, line: r.line, kind: r.is_definition ? "definition" : "reference" }));
  repoMap: Indexer["repoMap"] = (focus, budget) => this.b.repoMap(focus, budget);
}

const s = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v) throw new Error(`missing required argument: ${name}`);
  return v;
};
const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clip = (t: string, max = 16_000) => (t.length > max ? t.slice(0, max) + "\n[truncated]" : t);

/** Retrieval tools for the agent (section 3.2). All are read-only. */
export function createIndexTools(b: IndexBackend): RegisteredTool[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], run: RegisteredTool["run"]): RegisteredTool => ({
    spec: { name, description, parameters: { type: "object", properties, required }, class: "read" },
    run: async (args, ctx) => redactSecrets(clip(await run(args, ctx))),
  });
  return [
    tool("repo_map", "Ranked outline of the most important files and signatures, personalised to focus_files. Use first to orient yourself.", { focus_files: { type: "array", items: { type: "string" } }, token_budget: { type: "number" } }, [], async (a) =>
      (await b.repoMap(Array.isArray(a.focus_files) ? (a.focus_files as string[]) : [], n(a.token_budget, 2000))) || "index is empty or still building"),
    tool("semantic_search", "Find code chunks by meaning, e.g. 'where do we handle auth?'. Returns file:lines, score and the chunk.", { query: { type: "string" }, k: { type: "number" } }, ["query"], async (a) => {
      const hits = await b.semantic(s(a.query, "query"), n(a.k, 8));
      return hits.length ? hits.map((h) => `${h.file}:${h.start}-${h.end} (score ${h.score.toFixed(2)})\n${h.text}`).join("\n---\n") : "no results (index may still be building)";
    }),
    tool("grep", "Exact regular-expression search across the workspace (ripgrep-style, honours .gitignore). Optional glob like src/**/*.ts.", { pattern: { type: "string" }, glob: { type: "string" } }, ["pattern"], async (a) => {
      const hits = await b.grep(s(a.pattern, "pattern"), typeof a.glob === "string" && a.glob ? a.glob : undefined, 200);
      return hits.length ? hits.map((h) => `${h.file}:${h.line}:${h.text}`).join("\n") : "no matches";
    }),
    tool("symbol", "Precise lookup of a symbol's definition(s): location, signature and docstring.", { name: { type: "string" } }, ["name"], async (a) => {
      const hits = await b.symbol(s(a.name, "name"));
      return hits.length ? hits.map((h) => `${h.file}:${h.line}-${h.end_line} ${h.kind} ${h.signature}${h.doc ? `\n  doc: ${h.doc}` : ""}`).join("\n") : "symbol not found";
    }),
    tool("references", "All call sites and importers of a symbol. Call before changing a shared symbol and list every affected file in your plan.", { symbol: { type: "string" } }, ["symbol"], async (a) => {
      const hits = await b.references(s(a.symbol, "symbol"));
      return hits.length ? hits.map((h) => `${h.file}:${h.line}:${h.is_definition ? " [definition]" : ""} ${h.text}`).join("\n") : "no references found";
    }),
    tool("dependency_cone", "Upstream (dependents) and downstream (dependencies) files of a file, plus tests that cover it. Use to scope multi-file edits.", { file: { type: "string" } }, ["file"], async (a) => {
      const c = await b.cone(s(a.file, "file"));
      const list = (t: string, v: string[]) => `${t} (${v.length}):${v.length ? "\n  " + v.join("\n  ") : " none"}`;
      return [list("imports", c.imports), list("imported_by", c.imported_by), list("transitive_upstream", c.transitive_upstream), list("transitive_downstream", c.transitive_downstream), list("tests", c.tests)].join("\n");
    }),
  ];
}
