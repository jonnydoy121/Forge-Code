import { useEffect, useRef } from "react";
import { getDoc, isDirty, monaco } from "../lib/monaco";
import type { InlineContext } from "../lib/inlineEdit";

interface Props {
  path: string | null;
  dark: boolean;
  onDirty: (path: string, dirty: boolean) => void;
  /** Called on every edit with a lazy snapshot, so large files are not serialised per keystroke. */
  onChange: (path: string, language: string, snapshot: () => { version: number; text: string }) => void;
  onCursor: (line: number, col: number) => void;
  /** Alt+I or the context menu: edit the selection (or insert at the cursor) from an instruction. */
  onInlineEdit?: (ctx: InlineContext) => void;
}

export function Editor({ path, dark, onDirty, onChange, onCursor, onInlineEdit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const current = useRef<string | null>(null);
  const cb = useRef({ onDirty, onChange, onCursor, onInlineEdit });
  cb.current = { onDirty, onChange, onCursor, onInlineEdit };

  useEffect(() => {
    const ed = monaco.editor.create(host.current!, { automaticLayout: true, minimap: { enabled: false }, fontSize: 14, model: null });
    editor.current = ed;
    ed.onDidChangeModelContent(() => {
      const p = current.current;
      const d = p ? getDoc(p) : undefined;
      if (!p || !d) return;
      cb.current.onDirty(p, isDirty(d));
      cb.current.onChange(p, d.language, () => ({ version: d.model.getVersionId(), text: d.model.getValue() }));
    });
    ed.addAction({
      id: "forge.inlineEdit",
      label: "Forge-Code: Edit selection with AI",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyI],
      contextMenuGroupId: "navigation",
      run: (e) => {
        const p = current.current;
        const model = e.getModel();
        const sel = e.getSelection();
        if (!p || !model || !sel || !cb.current.onInlineEdit) return;
        cb.current.onInlineEdit({ path: p, language: model.getLanguageId(), text: model.getValue(), start: model.getOffsetAt(sel.getStartPosition()), end: model.getOffsetAt(sel.getEndPosition()) });
      },
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
