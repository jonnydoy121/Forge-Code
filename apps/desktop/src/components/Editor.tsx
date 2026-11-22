import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { getDoc, isDirty, loadMonaco } from "../lib/monaco";
import type { InlineContext } from "../lib/inlineEdit";
import type { CompletionContext } from "../lib/completion";

interface Props {
  path: string | null;
  dark: boolean;
  onDirty: (path: string, dirty: boolean) => void;
  /** Called on every edit with a lazy snapshot, so large files are not serialised per keystroke. */
  onChange: (path: string, language: string, snapshot: () => { version: number; text: string }) => void;
  onCursor: (line: number, col: number) => void;
  /** Alt+I or the context menu: edit the selection (or insert at the cursor) from an instruction. */
  onInlineEdit?: (ctx: InlineContext) => void;
  /** ghost-text completion at the cursor; resolves to "" for nothing. Aborted when the user keeps typing. */
  onComplete?: (ctx: CompletionContext, signal: AbortSignal) => Promise<string>;
}

/**
 * The Monaco engine is created the first time there is a file to show, not at startup: the window, file tree and agent
 * panel are usable while the ~3 MB engine is still loading (or was never needed).
 */
export function Editor({ path, dark, onDirty, onChange, onCursor, onInlineEdit, onComplete }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const ns = useRef<typeof Monaco | null>(null);
  const starting = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  const views = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  const current = useRef<string | null>(null);
  const cb = useRef({ onDirty, onChange, onCursor, onInlineEdit, onComplete });
  cb.current = { onDirty, onChange, onCursor, onInlineEdit, onComplete };
  const darkRef = useRef(dark);
  darkRef.current = dark;

  // Create the editor once there is something to show.
  useEffect(() => {
    if (!path || starting.current) return;
    starting.current = true;
    void loadMonaco().then(({ monaco }) => {
      if (!host.current) return;
      ns.current = monaco;
      monaco.editor.setTheme(darkRef.current ? "vs-dark" : "vs");
      const ed = monaco.editor.create(host.current, { automaticLayout: true, minimap: { enabled: false }, fontSize: 14, model: null });
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
      // Ghost-text completions. Registered once; it asks the app, which decides whether the feature is on.
      const provider = monaco.languages.registerInlineCompletionsProvider("*", {
        async provideInlineCompletions(model, position, _ctx, token) {
          const ask = cb.current.onComplete;
          if (!ask || model !== ed.getModel()) return { items: [] };
          await new Promise((r) => setTimeout(r, 350)); // debounce: only complete when typing pauses
          if (token.isCancellationRequested) return { items: [] };
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          const offset = model.getOffsetAt(position);
          const text = model.getValue();
          const insert = await ask({ path: current.current ?? "", language: model.getLanguageId(), prefix: text.slice(0, offset), suffix: text.slice(offset) }, abort.signal).catch(() => "");
          if (!insert || token.isCancellationRequested) return { items: [] };
          return { items: [{ insertText: insert, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
        },
        freeInlineCompletions() {},
      });
      ed.onDidChangeCursorPosition((e) => cb.current.onCursor(e.position.lineNumber, e.position.column));
      stop.current = () => {
        provider.dispose();
        ed.dispose();
      };
      setReady(true);
    });
  }, [path]);

  useEffect(() => () => stop.current?.(), []);

  // Show the right document (and restore where the cursor and scroll were).
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
  }, [path, ready]);

  useEffect(() => {
    ns.current?.editor.setTheme(dark ? "vs-dark" : "vs");
  }, [dark, ready]);

  return <div ref={host} className="h-full w-full" data-testid="editor" />;
}
