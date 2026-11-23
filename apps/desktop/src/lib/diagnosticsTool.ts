import { isSecretPath, relativeTo, resolveInRoot } from "@forge/protocol";
import type { RegisteredTool } from "@forge/tool-host";
import type { Diagnostic } from "./lspClient";
import type { FileCheck } from "./diagnosticsTracker";

export type CheckResult = FileCheck | { status: "no-server"; reason: string };

const MAX_SHOWN = 40;
const SEVERITY = { 1: "error", 2: "warning", 3: "info", 4: "hint" } as const;

/** Errors first, then by position; line and column are 1-based like the editor shows them. */
export function formatDiagnostics(file: string, diagnostics: Diagnostic[]): string {
  const sorted = [...diagnostics].sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  const count = (sev: number) => sorted.filter((d) => (d.severity ?? 1) === sev).length;
  const summary = (["error", "warning", "info", "hint"] as const)
    .map((name, i) => [count(i + 1), name] as const)
    .filter(([n]) => n > 0)
    .map(([n, name]) => `${n} ${name}${n === 1 ? "" : "s"}`)
    .join(", ");
  const lines = sorted.slice(0, MAX_SHOWN).map((d) => {
    const code = d.code !== undefined ? ` ${d.code}` : "";
    return `${file}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity ?? 1]}${code}: ${d.message.split("\n")[0]}`;
  });
  const more = sorted.length > MAX_SHOWN ? [`[${sorted.length - MAX_SHOWN} more not shown]`] : [];
  return [`${file}: ${summary}`, ...lines, ...more].join("\n");
}

/**
 * `diagnostics`: ask the language server about one file without running the project's checks. It sees the file as the agent
 * does (pending edits included), so it can verify an edit before the developer has accepted it.
 */
export function createDiagnosticsTool(check: (relPath: string, text: string) => Promise<CheckResult>): RegisteredTool {
  return {
    spec: {
      name: "diagnostics",
      description:
        "Check one file for errors and warnings from the language server (TypeScript/JavaScript and Python) in about a second, without running the project's checks. It checks the file as you see it, including your own unaccepted edits, so call it after editing a file and fix what it reports. It does not replace run_checks (tests, lint).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      class: "read",
    },
    async run(args, ctx) {
      if (typeof args.path !== "string" || !args.path) throw new Error("missing required argument: path");
      const abs = resolveInRoot(ctx.root, args.path);
      if (isSecretPath(abs)) throw new Error("refusing to read a file that looks like it holds secrets");
      const rel = relativeTo(ctx.root, abs);
      const text = await ctx.fs.readFile(abs);
      const r = await check(rel, text);
      if (r.status === "no-server") return `${rel}: not checked, ${r.reason}`;
      if (r.status === "timeout") return `${rel}: not checked, the language server did not answer in time (it may still be starting). Try again, or use run_checks.`;
      return r.diagnostics.length === 0 ? `${rel}: no problems found` : formatDiagnostics(rel, r.diagnostics);
    },
  };
}
