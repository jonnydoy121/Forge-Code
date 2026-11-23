import { describe, expect, it } from "vitest";
import { createToolHost, type FsBackend } from "@forge/tool-host";
import { createDiagnosticsTool, formatDiagnostics, type CheckResult } from "./diagnosticsTool";
import type { Diagnostic } from "./lspClient";

const d = (message: string, line: number, character: number, severity: Diagnostic["severity"] = 1, code?: string | number): Diagnostic => ({ range: { start: { line, character }, end: { line, character: character + 1 } }, severity, message, code });

describe("formatDiagnostics", () => {
  it("lists errors before warnings, 1-based, with a summary line", () => {
    const out = formatDiagnostics("src/a.ts", [d("unused", 0, 4, 2), d("Type 'string' is not assignable to type 'number'.\n  detail line", 9, 2, 1, 2322), d("missing semicolon", 3, 0, 1)]);
    expect(out.split("\n")).toEqual([
      "src/a.ts: 2 errors, 1 warning",
      "src/a.ts:4:1 error: missing semicolon",
      "src/a.ts:10:3 error 2322: Type 'string' is not assignable to type 'number'.",
      "src/a.ts:1:5 warning: unused",
    ]);
  });
  it("caps a long list and says how many were left out", () => {
    const many = Array.from({ length: 55 }, (_, i) => d(`problem ${i}`, i, 0));
    const lines = formatDiagnostics("a.ts", many).split("\n");
    expect(lines[0]).toBe("a.ts: 55 errors");
    expect(lines).toHaveLength(1 + 40 + 1);
    expect(lines.at(-1)).toBe("[15 more not shown]");
  });
});

describe("diagnostics tool", () => {
  const files: Record<string, string> = { "/ws/src/a.ts": "let x: number = 'a';\n", "/ws/.env": "TOKEN=abc123abc123\n" };
  const fs: FsBackend = {
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    readdir: async () => [],
  };
  const run = (check: (rel: string, text: string) => Promise<CheckResult>, args: Record<string, unknown>, mode: "ask" | "agent" = "ask") =>
    createToolHost({ root: "/ws", fs, tools: [createDiagnosticsTool(check)] }).call(mode, { id: "1", name: "diagnostics", args });

  it("checks the text the agent sees, under the workspace-relative path", async () => {
    let seen: [string, string] | undefined;
    const r = await run(async (rel, text) => ((seen = [rel, text]), { status: "ok", diagnostics: [d("Type 'string' is not assignable to type 'number'.", 0, 4, 1, 2322)] }), { path: "src/a.ts" });
    expect(seen).toEqual(["src/a.ts", "let x: number = 'a';\n"]);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("src/a.ts: 1 error\nsrc/a.ts:1:5 error 2322: Type 'string' is not assignable to type 'number'.");
  });

  it("says plainly when there is nothing wrong, when no server covers the file, and when the server was too slow", async () => {
    expect((await run(async () => ({ status: "ok", diagnostics: [] }), { path: "src/a.ts" })).output).toBe("src/a.ts: no problems found");
    expect((await run(async () => ({ status: "no-server", reason: "no language server for markdown" }), { path: "src/a.ts" })).output).toBe("src/a.ts: not checked, no language server for markdown");
    const slow = (await run(async () => ({ status: "timeout" }), { path: "src/a.ts" })).output;
    expect(slow).toContain("not checked");
    expect(slow).toContain("run_checks");
  });

  it("is a read tool (Ask and Plan mode can use it) and refuses secrets, escapes and missing arguments without asking the server", async () => {
    let asked = 0;
    const check = async (): Promise<CheckResult> => (asked++, { status: "ok", diagnostics: [] });
    expect((await run(check, { path: "src/a.ts" }, "ask")).ok).toBe(true);
    const before = asked;
    expect((await run(check, { path: ".env" })).output).toContain("secrets");
    expect((await run(check, { path: "../outside.ts" })).output).toContain("escapes workspace");
    expect((await run(check, {})).ok).toBe(false);
    expect((await run(check, { path: "src/missing.ts" })).ok).toBe(false);
    expect(asked).toBe(before);
  });
});
