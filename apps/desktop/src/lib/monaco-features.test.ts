// src/lib/monaco-features.ts lists Monaco's internal modules by path, so it is tied to the pinned Monaco version.
// These tests make an upgrade fail with a clear message here, instead of somewhere inside a build.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./monaco-features.ts", import.meta.url), "utf8");
const monacoRoot = dirname(require.resolve("monaco-editor/package.json"));
const monacoVersion = (JSON.parse(readFileSync(join(monacoRoot, "package.json"), "utf8")) as { version: string }).version;

/** Every `monaco-editor/...` specifier the file imports or re-exports. */
const specifiers = [...source.matchAll(/(?:import|export \*? ?from)\s+"(monaco-editor\/[^"]+)"/g)].map((m) => m[1]!);

describe("the trimmed Monaco feature list", () => {
  it("is pinned to the Monaco version it was written against", () => {
    // If this fails you upgraded Monaco. Re-derive the list from the new engine's own `editor/editor.all` and
    // `editor/edcore.main` entry modules (see the header of monaco-features.ts), then update this version.
    expect(monacoVersion).toBe("0.52.2");
  });

  it("lists a meaningful number of modules", () => {
    expect(specifiers.length).toBeGreaterThan(40);
  });

  it("only imports modules that exist in the installed Monaco", () => {
    const missing = specifiers.filter((s) => {
      const rel = s.replace("monaco-editor/", "");
      return !(existsSync(join(monacoRoot, rel)) || existsSync(join(monacoRoot, rel + ".js")));
    });
    expect(missing, `these paths no longer exist in Monaco ${monacoVersion}: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the features the app depends on (so a trim cannot silently remove them)", () => {
    for (const needed of ["findController", "folding", "hoverContribution", "gotoError", "suggestController", "inlineCompletions.contribution", "unicodeHighlighter", "toggleTabFocusMode", "standaloneCommandsQuickAccess", "language/json/monaco.contribution", "basic-languages/monaco.contribution"]) {
      expect(source, `${needed} must stay in the list`).toContain(needed);
    }
  });

  it("leaves out the language services whose workers are never provided", () => {
    for (const unused of ["language/typescript", "language/css", "language/html"]) expect(source).not.toMatch(new RegExp(`import "monaco-editor/esm/vs/${unused}`));
  });
});
