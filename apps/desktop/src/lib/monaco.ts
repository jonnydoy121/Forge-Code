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

interface Doc {
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
