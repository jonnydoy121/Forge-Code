// Language-server errors for the files a run touched, for the verification report's "LSP diagnostics" check.
// A file the editor has open already has markers; any other file (the agent edited it, the developer never opened it) is
// asked of the language server directly, so its errors are not silently missed.
import { UNCHECKED, type StructuredError } from "@forge/verify";
import type { CheckResult } from "./diagnosticsTool";

const MAX_FILES = 20;

export interface Sources {
  /** Workspace-relative files the run touched. */
  files: string[];
  /** Error markers when the editor has the file open, or null when it does not. */
  open: (rel: string) => StructuredError[] | null;
  /** The file's current text, or null if it does not exist (verification runs once changes are accepted, so this is the disk). */
  read: (rel: string) => Promise<string | null>;
  /** Ask the language server; absent when this workspace has none (an isolated thread). */
  check?: (rel: string, text: string) => Promise<CheckResult>;
}

const gap = (file: string, message: string): StructuredError => ({ file, message, severity: "warning", rule: UNCHECKED });

export async function collectErrors(s: Sources): Promise<StructuredError[]> {
  const out: StructuredError[] = [];
  const unopened: string[] = [];
  for (const rel of s.files) {
    const markers = s.open(rel);
    if (markers) out.push(...markers);
    else unopened.push(rel);
  }
  if (s.check) {
    const check = s.check;
    // In parallel: the server loads the project once, and checks of different files do not wait for each other.
    const found = await Promise.all(
      unopened.slice(0, MAX_FILES).map(async (rel): Promise<StructuredError[]> => {
        try {
          const text = await s.read(rel);
          if (text === null) return []; // deleted by the run: nothing left to check
          const r = await check(rel, text);
          if (r.status === "timeout") return [gap(rel, "the language server did not answer in time")];
          if (r.status === "no-server") return r.unsupported ? [] : [gap(rel, "the language server is not available")]; // a type with no server at all is not worth mentioning
          return r.diagnostics
            .filter((d) => (d.severity ?? 1) === 1)
            .map((d) => ({ file: rel, line: d.range.start.line + 1, col: d.range.start.character + 1, rule: d.code !== undefined ? String(d.code) : undefined, message: d.message.split("\n")[0]!, severity: "error" as const }));
        } catch {
          return []; // unreadable (deleted, binary): leave it to the other checks
        }
      }),
    );
    out.push(...found.flat());
    for (const rel of unopened.slice(MAX_FILES)) out.push(gap(rel, `more than ${MAX_FILES} files changed`));
  }
  return out;
}
