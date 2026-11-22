import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { languageForPath, normalizeUri, pathToUri } from "./uri";
import { fsApi } from "./ipc";
import type { Diagnostic } from "./lspClient";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// Diagnostics come from real language servers over LSP, so silence Monaco's bundled TS checker.
// The API moved between Monaco releases (languages.typescript vs typescript); handle both.
const m = monaco as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
for (const ns of [m.typescript, m.languages?.typescript]) {
  for (const defaults of [ns?.typescriptDefaults, ns?.javascriptDefaults]) {
    defaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: true });
  }
}

export { monaco };

export interface Doc {
  model: monaco.editor.ITextModel;
  savedAltVersion: number;
  language: string;
}

const docs = new Map<string, Doc>();
const byUri = new Map<string, Doc>();

export function getDoc(path: string) {
  return docs.get(path);
}

export async function openDoc(path: string): Promise<Doc> {
  const existing = docs.get(path);
  if (existing) return existing;
  const text = await fsApi.readFile(path);
  const language = languageForPath(path);
  const model = monaco.editor.createModel(text, language, monaco.Uri.parse(pathToUri(path)));
  const doc: Doc = { model, savedAltVersion: model.getAlternativeVersionId(), language };
  docs.set(path, doc);
  byUri.set(normalizeUri(pathToUri(path)), doc);
  return doc;
}

export function disposeDoc(path: string) {
  const d = docs.get(path);
  if (!d) return;
  byUri.delete(normalizeUri(pathToUri(path)));
  docs.delete(path);
  d.model.dispose();
}

export async function saveDoc(path: string) {
  const d = docs.get(path);
  if (!d) return;
  await fsApi.writeFile(path, d.model.getValue());
  d.savedAltVersion = d.model.getAlternativeVersionId();
}

export const isDirty = (d: Doc) => d.model.getAlternativeVersionId() !== d.savedAltVersion;

/** Apply LSP diagnostics to the model that owns the URI. Returns [errors, warnings]. */
export function applyDiagnostics(uri: string, diags: Diagnostic[]): [number, number] {
  const d = byUri.get(normalizeUri(uri));
  if (!d) return [0, 0];
  const sev = [0, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];
  monaco.editor.setModelMarkers(
    d.model,
    "lsp",
    diags.map((x) => ({
      severity: sev[x.severity ?? 1] ?? monaco.MarkerSeverity.Error,
      message: x.message,
      source: x.source,
      code: x.code === undefined ? undefined : String(x.code),
      startLineNumber: x.range.start.line + 1,
      startColumn: x.range.start.character + 1,
      endLineNumber: x.range.end.line + 1,
      endColumn: x.range.end.character + 1,
    })),
  );
  return [diags.filter((x) => (x.severity ?? 1) === 1).length, diags.filter((x) => x.severity === 2).length];
}

/**
 * Re-read open, unmodified documents from disk (after accepted agent edits or rollbacks).
 * Documents with unsaved developer edits are left alone: the developer's text always wins.
 * Returns the paths that changed.
 */
export async function reloadOpenDocs(): Promise<string[]> {
  const changed: string[] = [];
  for (const [path, d] of docs) {
    if (isDirty(d)) continue;
    let text: string;
    try {
      text = await fsApi.readFile(path);
    } catch {
      continue; // deleted on disk
    }
    if (text !== d.model.getValue()) {
      d.model.setValue(text);
      d.savedAltVersion = d.model.getAlternativeVersionId();
      changed.push(path);
    }
  }
  return changed;
}

export interface HunkMark { oldStart: number; oldCount: number; added: string[] }

const decorationIds = new Map<string, string[]>();

/** Show pending agent changes on the real file: removed/replaced lines in red, insertion points in green. */
export function showPendingDecorations(path: string, marks: HunkMark[]) {
  const d = docs.get(path);
  if (!d) return;
  const lineCount = d.model.getLineCount();
  const decos: monaco.editor.IModelDeltaDecoration[] = marks.map((m) => {
    const added = m.added.length ? `**Proposed:**\n\`\`\`\n${m.added.slice(0, 12).join("\n")}\n\`\`\`` : "**Proposed:** remove these lines";
    if (m.oldCount > 0) {
      const start = Math.min(m.oldStart + 1, lineCount);
      const end = Math.min(m.oldStart + m.oldCount, lineCount);
      return { range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, className: m.added.length ? "pending-changed" : "pending-removed", hoverMessage: { value: added } } };
    }
    const line = Math.min(Math.max(m.oldStart, 1), lineCount);
    return { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: m.oldStart === 0 ? "pending-insert-top" : "pending-insert", hoverMessage: { value: added } } };
  });
  decorationIds.set(path, d.model.deltaDecorations(decorationIds.get(path) ?? [], decos));
}

export function clearPendingDecorations(path: string) {
  const d = docs.get(path);
  if (d && decorationIds.has(path)) d.model.deltaDecorations(decorationIds.get(path)!, []);
  decorationIds.delete(path);
}

/** Error-severity LSP markers for the given workspace-relative files that are open in the editor. */
export function errorMarkers(root: string, relFiles: string[]): { file: string; line: number; col: number; message: string; rule?: string; severity: "error" }[] {
  const out: { file: string; line: number; col: number; message: string; rule?: string; severity: "error" }[] = [];
  const base = root.split("\\").join("/").replace(/\/+$/, "");
  for (const [path, d] of docs) {
    const rel = path.split("\\").join("/").replace(base + "/", "");
    if (!relFiles.includes(rel)) continue;
    for (const m of monaco.editor.getModelMarkers({ resource: d.model.uri })) {
      if (m.severity === monaco.MarkerSeverity.Error) out.push({ file: rel, line: m.startLineNumber, col: m.startColumn, message: m.message, rule: typeof m.code === "string" ? m.code : undefined, severity: "error" });
    }
  }
  return out;
}
