import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Editor } from "./components/Editor";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { Terminal } from "./components/Terminal";
import { CommandPalette } from "./components/CommandPalette";
import { AgentPanel } from "./components/AgentPanel";
import { fsApi } from "./lib/ipc";
import { applyDiagnostics, disposeDoc, getDoc, isDirty, openDoc, saveDoc } from "./lib/monaco";
import { LspManager, serverKeyFor, type ServerKey, type ServerStatus } from "./lib/lspManager";
import { initialTabs, tabsReducer } from "./lib/tabs";
import { matchesKeybinding, type Command } from "./lib/commands";
import { pathToUri } from "./lib/uri";

export function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [tabs, dispatch] = useReducer(tabsReducer, initialTabs);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalEverOpened, setTerminalEverOpened] = useState(false);
  const [dark, setDark] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState<[number, number]>([1, 1]);
  const [counts, setCounts] = useState<Record<string, [number, number]>>({});
  const [servers, setServers] = useState<Partial<Record<ServerKey, ServerStatus>>>({});
  const lsp = useRef(new LspManager());

  useEffect(() => {
    lsp.current.onDiagnostics((uri, diags) => {
      const c = applyDiagnostics(uri, diags);
      setCounts((prev) => ({ ...prev, [decodeURIComponent(uri).toLowerCase()]: c }));
    });
    lsp.current.onStatus((key, s) => setServers((prev) => ({ ...prev, [key]: s })));
    fsApi.initialWorkspace().then((w) => w && void openFolder(w)).catch(() => {});
  }, []);

  async function openFolder(dir: string) {
    for (const t of tabs.tabs) disposeDoc(t.path);
    dispatch({ type: "reset" });
    setCounts({});
    setServers({});
    await lsp.current.setRoot(dir);
    setRoot(dir);
  }

  const chooseFolder = useCallback(async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string") await openFolder(dir);
  }, [tabs.tabs]);

  const openFile = useCallback(async (path: string) => {
    try {
      const doc = await openDoc(path);
      dispatch({ type: "open", path });
      setNotice(null);
      void lsp.current.open(path, doc.language, doc.model.getVersionId(), doc.model.getValue());
    } catch (e) {
      setNotice(`Cannot open ${path.split(/[\\/]/).pop()}: ${e}`);
    }
  }, []);

  const save = useCallback(async () => {
    if (!tabs.active) return;
    try {
      await saveDoc(tabs.active);
      dispatch({ type: "dirty", path: tabs.active, dirty: false });
    } catch (e) {
      setNotice(`Save failed: ${e}`);
    }
  }, [tabs.active]);

  const closeTab = useCallback(
    async (path: string) => {
      const d = getDoc(path);
      if (d && isDirty(d)) {
        const discard = await ask(`${path.split(/[\\/]/).pop()} has unsaved changes. Discard them?`, { title: "Unsaved changes", kind: "warning" });
        if (!discard) return;
      }
      if (d) void lsp.current.close(path, d.language);
      disposeDoc(path);
      dispatch({ type: "close", path });
    },
    [],
  );

  const commands: Command[] = useMemo(
    () => [
      { id: "open-folder", title: "File: Open Folder", keybinding: "Ctrl+O", run: () => void chooseFolder() },
      { id: "save", title: "File: Save", keybinding: "Ctrl+S", run: () => void save() },
      { id: "close-tab", title: "View: Close Editor", keybinding: "Ctrl+W", run: () => tabs.active && void closeTab(tabs.active) },
      { id: "terminal", title: "View: Toggle Terminal", keybinding: "Ctrl+`", run: () => toggleTerminal() },
      { id: "agent-panel", title: "View: Toggle Agent Panel", keybinding: "Ctrl+L", run: () => setAgentOpen((o) => !o) },
      { id: "theme", title: "View: Toggle Light/Dark Theme", run: () => setDark((d) => !d) },
    ],
    [chooseFolder, save, closeTab, tabs.active],
  );

  function toggleTerminal() {
    setTerminalEverOpened(true);
    setTerminalOpen((o) => !o);
  }

  const palette: Command = { id: "palette", title: "Show Command Palette", keybinding: "Ctrl+Shift+P", run: () => setPaletteOpen(true) };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const all = [...commands, palette];
      const hit = all.find((c) => c.keybinding && matchesKeybinding(e, c.keybinding));
      if (hit) {
        e.preventDefault();
        hit.run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commands]);

  const activeDoc = tabs.active ? getDoc(tabs.active) : undefined;
  const activeCounts = tabs.active ? counts[decodeURIComponent(pathToUri(tabs.active)).toLowerCase()] : undefined;
  const serverKey = activeDoc ? serverKeyFor(activeDoc.language) : null;
  const server = serverKey ? servers[serverKey] : undefined;

  return (
    <div className={`flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)] ${dark ? "" : "light"}`} data-theme={dark ? "dark" : "light"}>
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r border-[var(--border)] bg-[var(--panel)]">
          {root ? (
            <FileTree root={root} activePath={tabs.active} onOpen={(p) => void openFile(p)} />
          ) : (
            <div className="p-3 text-sm">
              <button className="rounded bg-[var(--hover)] px-3 py-1.5" onClick={() => void chooseFolder()} data-testid="open-folder">
                Open Folder
              </button>
              <p className="mt-2 text-[var(--muted)]">Or press Ctrl+Shift+P.</p>
            </div>
          )}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <TabBar state={tabs} onActivate={(p) => dispatch({ type: "activate", path: p })} onClose={(p) => void closeTab(p)} />
          {notice && <div className="bg-red-900/40 px-3 py-1 text-sm" role="alert">{notice}</div>}
          <div className="min-h-0 flex-1">
            <Editor
              path={tabs.active}
              dark={dark}
              onDirty={(path, dirty) => dispatch({ type: "dirty", path, dirty })}
              onChange={(path, language, version, text) => void lsp.current.change(path, language, version, text)}
              onCursor={(l, c) => setCursor([l, c])}
            />
          </div>
          {terminalEverOpened && (
            <div className={`h-64 border-t border-[var(--border)] ${terminalOpen ? "" : "hidden"}`}>
              <Terminal cwd={root} visible={terminalOpen} dark={dark} />
            </div>
          )}
        </section>
        {agentOpen && <AgentPanel root={root} activePath={tabs.active} />}
      </div>
      <footer className="flex gap-4 border-t border-[var(--border)] bg-[var(--panel)] px-3 py-0.5 text-xs text-[var(--muted)]" data-testid="status">
        <span>{root ?? "No folder open"}</span>
        <span className="ml-auto">{activeDoc?.language ?? ""}</span>
        {server && (
          <span data-testid="lsp-status" title={server.detail}>
            LSP: {server.state}
            {activeCounts ? ` | ${activeCounts[0]} errors, ${activeCounts[1]} warnings` : ""}
          </span>
        )}
        <span>
          Ln {cursor[0]}, Col {cursor[1]}
        </span>
      </footer>
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
