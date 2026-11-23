import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolHost, readFileTool, type RegisteredTool } from "../src";
import { nodeFs } from "../src/node-fs";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-th-")).replace(/\\/g, "/");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules/x"), { recursive: true });
  mkdirSync(join(root, "src/[id]"), { recursive: true });
  writeFileSync(join(root, "src/[id]/page.ts"), "export default 1;\n");
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\nexport function hello() {}\n");
  writeFileSync(join(root, "src/b.py"), "def hello():\n  pass\n");
  writeFileSync(join(root, ".env"), "TOKEN=supersecretvalue123\n");
  writeFileSync(join(root, "node_modules/x/i.js"), "hello\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const host = () => createToolHost({ root, fs: nodeFs });
const call = (name: string, args: Record<string, unknown>, mode: "ask" | "agent" = "ask") =>
  host().call(mode, { id: "1", name, args });

describe("mode enforcement", () => {
  const writeTool: RegisteredTool = {
    spec: { name: "write_file", description: "w", parameters: { type: "object" }, class: "write" },
    run: async () => "wrote",
  };
  const h = createToolHost({ root, fs: nodeFs, tools: [readFileTool, writeTool] });
  it("does not list write tools in ask/plan mode and lists them in agent mode", () => {
    expect(h.listTools("ask").map((t) => t.name)).toEqual(["read_file"]);
    expect(h.listTools("plan").map((t) => t.name)).toEqual(["read_file"]);
    expect(h.listTools("agent").map((t) => t.name)).toEqual(["read_file", "write_file"]);
  });
  it("rejects a hallucinated write call in ask mode", async () => {
    const r = await h.call("ask", { id: "x", name: "write_file", args: {} });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("not available in ask mode");
  });
});

describe("read_file", () => {
  it("returns numbered lines for a range", async () => {
    const r = await call("read_file", { path: "src/a.ts", start_line: 2, end_line: 2 });
    expect(r).toEqual({ id: "1", ok: true, output: "2\texport function hello() {}" });
  });
  it("blocks path traversal and secret files", async () => {
    expect((await call("read_file", { path: "../outside.txt" })).output).toContain("escapes workspace");
    expect((await call("read_file", { path: ".env" })).output).toContain("secrets");
  });
  it("reports missing arguments as tool errors, not crashes", async () => {
    expect((await call("read_file", {})).ok).toBe(false);
  });
});

describe("ls and grep", () => {
  it("ls hides ignored dirs and secret files", async () => {
    expect((await call("ls", {})).output).toBe("src/");
  });
  it("grep finds matches, skips node_modules and secrets, honours glob", async () => {
    const all = (await call("grep", { pattern: "hello" })).output.split("\n");
    expect(all.sort()).toEqual(["src/a.ts:2:export function hello() {}", "src/b.py:1:def hello():"]);
    expect((await call("grep", { pattern: "hello", glob: "*.py" })).output).toBe("src/b.py:1:def hello():");
    expect((await call("grep", { pattern: "supersecret" })).output).toBe("no matches");
  });
  it("grep can ignore case and list only the files that match", async () => {
    expect((await call("grep", { pattern: "HELLO" })).output).toBe("no matches");
    const loose = (await call("grep", { pattern: "HELLO", ignore_case: true })).output.split("\n").sort();
    expect(loose).toEqual(["src/a.ts:2:export function hello() {}", "src/b.py:1:def hello():"]);
    expect((await call("grep", { pattern: "hello", files_only: true })).output.split("\n").sort()).toEqual(["src/a.ts", "src/b.py"]);
    expect((await call("grep", { pattern: "hello", files_only: true, glob: "*.py" })).output).toBe("src/b.py");
  });
});

describe("find_files", () => {
  it("finds by glob anywhere, by anchored glob, and by case-insensitive substring; never lists ignored or secret files", async () => {
    expect((await call("find_files", { pattern: "*.py" })).output).toBe("src/b.py");
    expect((await call("find_files", { pattern: "src/*.ts" })).output).toBe("src/a.ts");
    expect((await call("find_files", { pattern: "B.P" })).output).toBe("src/b.py");
    expect((await call("find_files", { pattern: "*.{ts,py}" })).output.split("\n").sort()).toEqual(["src/[id]/page.ts", "src/a.ts", "src/b.py"]);
    for (const hidden of ["env", "node_modules", "i.js"]) expect((await call("find_files", { pattern: hidden })).output, hidden).toBe("no files found");
  });
  it("treats a bracket as a plain character: a route segment like [id] is found by its name", async () => {
    expect((await call("find_files", { pattern: "[id]" })).output).toBe("src/[id]/page.ts");
    expect((await call("find_files", { pattern: "[ID]/PAGE" })).output).toBe("src/[id]/page.ts");
    expect((await call("find_files", { pattern: "[nothing]" })).output).toBe("no files found");
  });
  it("is a read tool: available in ask mode, and a missing pattern is a tool error", async () => {
    expect(host().listTools("ask").map((t) => t.name)).toContain("find_files");
    expect((await call("find_files", {})).ok).toBe(false);
  });
});
