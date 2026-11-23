import { describe, expect, it } from "vitest";
import { createToolHost, type FsBackend } from "@forge/tool-host";
import { EmptyIndexer, IndexClient, createIndexTools, type IndexBackend } from "../src";

const fakeBackend = (over: Partial<IndexBackend> = {}): IndexBackend => ({
  grep: async () => [{ file: "src/a.ts", line: 3, text: "needle" }],
  symbol: async () => [{ name: "getById", kind: "method", file: "src/user.ts", line: 5, end_line: 9, signature: "getById(id: string)", doc: "Looks up a user" }],
  references: async () => [
    { file: "src/user.ts", line: 5, text: "getById(id)", is_definition: true },
    { file: "src/api.ts", line: 3, text: "svc.getById(id)", is_definition: false },
  ],
  repoMap: async (focus) => `focus=${focus.join(",")}`,
  semantic: async () => [{ file: "src/auth.ts", start: 2, end: 4, score: 0.8, text: "function validatePassword() {}" }],
  cone: async () => ({ imports: ["src/auth.ts"], imported_by: ["src/api.ts"], transitive_upstream: ["src/api.ts"], transitive_downstream: ["src/auth.ts"], tests: ["src/user.test.ts"] }),
  ...over,
});

const nofs: FsBackend = { readFile: async () => "", readdir: async () => [] };
const host = (b: IndexBackend) => createToolHost({ root: "/ws", fs: nofs, tools: createIndexTools(b) });
const call = (b: IndexBackend, name: string, args: Record<string, unknown>) => host(b).call("ask", { id: "1", name, args });

describe("Indexer contract", () => {
  it("empty indexer returns empty results", async () => {
    const i = new EmptyIndexer();
    expect(await i.grep("x")).toEqual([]);
    expect(await i.symbol("x")).toBeUndefined();
  });
  it("IndexClient maps backend results onto the Indexer contract", async () => {
    const c = new IndexClient(fakeBackend());
    expect(await c.symbol("getById")).toEqual({ name: "getById", file: "src/user.ts", line: 5, kind: "method" });
    expect((await c.references("getById")).map((r) => r.kind)).toEqual(["definition", "reference"]);
  });
});

describe("grep and find_files tools", () => {
  it("grep passes ignore_case to the backend as an inline flag and files_only lists each file once", async () => {
    const seen: string[] = [];
    const b = fakeBackend({
      grep: async (pattern) => {
        seen.push(pattern);
        return [
          { file: "src/b.ts", line: 1, text: "x" },
          { file: "src/a.ts", line: 9, text: "x" },
          { file: "src/a.ts", line: 3, text: "x" },
        ];
      },
    });
    expect((await call(b, "grep", { pattern: "needle", ignore_case: true })).output).toContain("src/b.ts:1:x");
    expect(seen[0]).toBe("(?i)needle");
    expect((await call(b, "grep", { pattern: "needle" })).ok).toBe(true);
    expect(seen[1]).toBe("needle");
    expect((await call(b, "grep", { pattern: "needle", files_only: true })).output).toBe("src/a.ts" + "\n" + "src/b.ts");
  });
  it("find_files is only offered when the backend can list files", async () => {
    expect(host(fakeBackend()).listTools("ask").map((t) => t.name)).not.toContain("find_files");
    const b = fakeBackend({ findFiles: async (p) => (p === "auth" ? ["src/auth.ts", "src/auth.test.ts"] : []) });
    expect(host(b).listTools("ask").map((t) => t.name)).toContain("find_files");
    expect((await call(b, "find_files", { pattern: "auth" })).output).toBe("src/auth.ts" + "\n" + "src/auth.test.ts");
    expect((await call(b, "find_files", { pattern: "zzz" })).output).toBe("no files found");
  });
});

describe("retrieval tools", () => {
  it("are all read-class so Ask/Plan mode can use them", () => {
    const names = host(fakeBackend()).listTools("ask").map((t) => t.name);
    expect(names).toEqual(["repo_map", "semantic_search", "grep", "symbol", "references", "dependency_cone"]);
  });
  it("format results compactly", async () => {
    expect((await call(fakeBackend(), "grep", { pattern: "needle" })).output).toBe("src/a.ts:3:needle");
    expect((await call(fakeBackend(), "symbol", { name: "getById" })).output).toContain("src/user.ts:5-9 method getById(id: string)\n  doc: Looks up a user");
    expect((await call(fakeBackend(), "references", { symbol: "getById" })).output).toBe("src/user.ts:5: [definition] getById(id)\nsrc/api.ts:3: svc.getById(id)");
    expect((await call(fakeBackend(), "dependency_cone", { file: "src/user.ts" })).output).toContain("tests (1):\n  src/user.test.ts");
    expect((await call(fakeBackend(), "semantic_search", { query: "auth" })).output).toContain("src/auth.ts:2-4 (score 0.80)");
    expect((await call(fakeBackend(), "repo_map", { focus_files: ["a.ts", "b.ts"] })).output).toBe("focus=a.ts,b.ts");
  });
  it("report empty results explicitly and validate arguments", async () => {
    expect((await call(fakeBackend({ grep: async () => [] }), "grep", { pattern: "x" })).output).toBe("no matches");
    expect((await call(fakeBackend(), "grep", {})).ok).toBe(false);
  });
  it("redact secrets that appear in indexed text", async () => {
    const b = fakeBackend({ grep: async () => [{ file: "a.ts", line: 1, text: 'const apiKey = "abcd1234efgh5678"' }] });
    expect((await call(b, "grep", { pattern: "key" })).output).not.toContain("abcd1234efgh5678");
  });
});
