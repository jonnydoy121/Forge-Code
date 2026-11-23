import { describe, expect, it } from "vitest";
import { collectErrors } from "./verifyDiagnostics";
import type { CheckResult } from "./diagnosticsTool";
import type { Diagnostic } from "./lspClient";

const diag = (message: string, line: number, character: number, severity: Diagnostic["severity"] = 1, code?: string | number): Diagnostic => ({ range: { start: { line, character }, end: { line, character: character + 1 } }, severity, message, code });
const marker = (file: string, message: string) => ({ file, line: 1, col: 1, message, severity: "error" as const });

describe("collectErrors", () => {
  it("uses editor markers for open files and asks the language server only about the others", async () => {
    const asked: string[] = [];
    const errors = await collectErrors({
      files: ["src/open.ts", "src/closed.ts"],
      open: (rel) => (rel === "src/open.ts" ? [marker(rel, "from the editor")] : null),
      read: async (rel) => `text of ${rel}`,
      check: async (rel, text) => (asked.push(`${rel}:${text}`), { status: "ok", diagnostics: [diag("Type 'string' is not assignable to type 'number'.\n  more detail", 4, 2, 1, 2322)] }),
    });
    expect(asked).toEqual(["src/closed.ts:text of src/closed.ts"]);
    expect(errors).toEqual([marker("src/open.ts", "from the editor"), { file: "src/closed.ts", line: 5, col: 3, rule: "2322", message: "Type 'string' is not assignable to type 'number'.", severity: "error" }]);
  });

  it("keeps only errors: warnings, hints and info from the server are not verification failures", async () => {
    const errors = await collectErrors({
      files: ["a.ts"],
      open: () => null,
      read: async () => "x",
      check: async () => ({ status: "ok", diagnostics: [diag("unused", 0, 0, 2), diag("hint", 1, 0, 4), diag("real", 2, 0, 1), diag("no severity means error", 3, 0, undefined)] }),
    });
    expect(errors.map((e) => e.message)).toEqual(["real", "no severity means error"]);
  });

  it("claims nothing for files it could not check: no server, a slow server, or an unreadable file", async () => {
    const results: Record<string, CheckResult> = { "a.md": { status: "no-server", reason: "none" }, "b.ts": { status: "timeout" }, "c.ts": { status: "ok", diagnostics: [diag("c is broken", 0, 0)] } };
    const errors = await collectErrors({
      files: ["a.md", "b.ts", "gone.ts", "deleted.ts", "c.ts"],
      open: () => null,
      read: async (rel) => {
        if (rel === "gone.ts") throw new Error("ENOENT");
        if (rel === "deleted.ts") return null;
        return "x";
      },
      check: async (rel) => results[rel]!,
    });
    expect(errors.map((e) => `${e.file}: ${e.message}`)).toEqual(["c.ts: c is broken"]);
  });

  it("does nothing extra when there is no language server to ask (an isolated thread)", async () => {
    const errors = await collectErrors({ files: ["a.ts", "b.ts"], open: (rel) => (rel === "a.ts" ? [marker(rel, "m")] : null), read: async () => "x" });
    expect(errors).toEqual([marker("a.ts", "m")]);
  });

  it("checks files in parallel, and no more than 20 of them", async () => {
    let running = 0;
    let peak = 0;
    const asked: string[] = [];
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    await collectErrors({
      files,
      open: () => null,
      read: async () => "x",
      check: async (rel) => {
        asked.push(rel);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { status: "ok", diagnostics: [] };
      },
    });
    expect(asked).toHaveLength(20);
    expect(peak).toBeGreaterThan(1);
  });
});
