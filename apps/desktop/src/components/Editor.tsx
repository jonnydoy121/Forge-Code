import { useEffect, useRef } from "react";
import { getDoc, isDirty, monaco } from "../lib/monaco";

interface Props {
  path: string | null;
  dark: boolean;
  onDirty: (path: string, dirty: boolean) => void;
  onChange: (path: string, language: string, version: number, text: string) => void;
  onCursor: (line: number, col: number) => void;
}

export function Editor({ path, dark, onDirty, onChange, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const current = useRef<string | null>(null);
  const cb = useRef({ onDirty, onChange, onCursor });
  cb.current = { onDirty, onChange, onCursor };

  useEffect(() => {
    const ed = monaco.editor.create(host.current!, { automaticLayout: true, minimap: { enabled: false }, fontSize: 14, model: null });
    editor.current = ed;
    ed.onDidChangeModelContent(() => {
      const p = current.current;
      const d = p ? getDoc(p) : undefined;
      if (!p || !d) return;
      cb.current.onDirty(p, isDirty(d));
      cb.current.onChange(p, d.language, d.model.getVersionId(), d.model.getValue());
    });
    ed.onDidChangeCursorPosition((e) => cb.current.onCursor(e.position.lineNumber, e.position.column));
    return () => ed.dispose();
  }, []);

  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    if (current.current) views.current.set(current.current, ed.saveViewState());
    current.current = path;
    const d = path ? getDoc(path) : undefined;
    ed.setModel(d?.model ?? null);
    if (path && d) {
      const v = views.current.get(path);
      if (v) ed.restoreViewState(v);
      ed.focus();
    }
  }, [path]);

  useEffect(() => monaco.editor.setTheme(dark ? "vs-dark" : "vs"), [dark]);

  return <div ref={host} className="h-full w-full" data-testid="editor" />;
}
