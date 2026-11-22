import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Editor } from "./components/Editor";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { Terminal } from "./components/Terminal";
import { CommandPalette } from "./components/CommandPalette";
import { AgentPanel } from "./components/AgentPanel";
import { ReviewPane } from "./components/ReviewPane";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { PlanPane } from "./components/PlanPane";
import { Welcome, needsOnboarding } from "./components/Welcome";
import { ContextPane } from "./components/ContextPane";
import { AddFilePrompt, QuestionPrompt } from "./components/Prompts";
import { PlanExecutor, type Question } from "@forge/plans";
import type { RunOutcome } from "./components/AgentPanel";
import type { AskRequest, Remember } from "@forge/safety";
import type { Mode } from "@forge/protocol";
import { createWorkspaceServices, norm, type ReportEvent, type WorkspaceServices } from "./lib/workspace";
import { loadSettings } from "./lib/settings";
import { loadApiKey } from "./lib/secrets";
import { completeOnce } from "./lib/agentSession";
import { buildInlinePrompt, extractReplacement, spliceSelection, type InlineContext } from "./lib/inlineEdit";
import { invoke } from "@tauri-apps/api/core";
import { fsApi, indexApi, type IndexStatus } from "./lib/ipc";
import { applyDiagnostics, clearPendingDecorations, errorMarkers, disposeDoc, getDoc, isDirty, openDoc, reloadOpenDocs, saveDoc, showPendingDecorations } from "./lib/monaco";
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
  const [inline, setInline] = useState<{ ctx: InlineContext; busy: boolean; done: string | null } | null>(null);
  const [cursor, setCursor] = useState<[number, number]>([1, 1]);
  const [counts, setCounts] = useState<Record<string, [number, number]>>({});
  const [servers, setServers] = useState<Partial<Record<ServerKey, ServerStatus>>>({});
  const [indexInfo, setIndexInfo] = useState<{ progress?: string; status?: IndexStatus }>({});
  const [services, setServices] = useState<WorkspaceServices | null>(null);
  const [version, setVersion] = useState(0);
  const [view, setView] = useState<"editor" | "review" | "plan" | "context">("editor");
  const sendRef = useRef<(prompt: string, mode?: Mode) => Promise<RunOutcome>>(async () => ({}));
  const registerSend = useCallback((fn: (prompt: string, mode?: Mode) => Promise<RunOutcome>) => {
    sendRef.current = fn;
  }, []);
  const [activePlan, setActivePlan] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const buildAbort = useRef<AbortController | null>(null);
  const [questionReq, setQuestionReq] = useState<{ questions: Question[]; resolve: (a: string[]) => void } | null>(null);
  const [addFileReq, setAddFileReq] = useState<{ question: string; path: string; resolve: (b: boolean) => void } | null>(null);
  const [welcome, setWelcome] = useState(needsOnboarding);
  const [report, setReport] = useState<ReportEvent | null>(null);
  const [sandboxMode, setSandboxMode] = useState<string>("");
  const [localOnly, setLocalOnly] = useState(() => loadSettings().localOnly);
  // Parallel threads can ask at the same time: prompts queue and are answered one at a time, never dropped.
  const [permissions, setPermissions] = useState<{ req: AskRequest; resolve: (a: Remember) => void }[]>([]);
  const permission = permissions[0] ?? null;
  const [threads, setThreads] = useState([{ id: "main", name: "Thread 1" }]);
  const [activeThread, setActiveThread] = useState("main");
  const [busyThreads, setBusyThreads] = useState<Record<string, boolean>>({});
  const nextThread = useRef(2);
  const threadBusy = useCallback((id: string, busy: boolean) => setBusyThreads((b) => (b[id] === busy ? b : { ...b, [id]: busy })), []);
  const rootRef = useRef<string | null>(null);
  const lsp = useRef(new LspManager());
  const lspTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    lsp.current.onDiagnostics((uri, diags) => {
      const c = applyDiagnostics(uri, diags);
      setCounts((prev) => ({ ...prev, [decodeURIComponent(uri).toLowerCase()]: c }));
    });
    lsp.current.onStatus((key, s) => setServers((prev) => ({ ...prev, [key]: s })));
    const subs = [
      indexApi.onProgress((p) => setIndexInfo((i) => ({ ...i, progress: p.phase === "done" ? undefined : `${p.phase} ${p.done}/${p.total || "?"}` }))),
      indexApi.onBuilt(() => void indexApi.status().then((status) => setIndexInfo({ status }))),
      indexApi.onUpdated(() => void indexApi.status().then((status) => setIndexInfo((i) => ({ ...i, status })))),
    ];
    void invoke<string>("sandbox_status").then(setSandboxMode).catch(() => {});
    const poll = setInterval(() => setLocalOnly(loadSettings().localOnly), 1000);
    fsApi.initialWorkspace().then((w) => w && void openFolder(w)).catch(() => {});
    return () => {
      clearInterval(poll);
      for (const s of subs) void s.then((unlisten) => unlisten());
    };
  }, []);

  // Test hook (dev builds only): lets end-to-end tests open a workspace without the native folder dialog.
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __forge?: unknown }).__forge = { openFolder: (d: string) => openFolder(d), services };
  });

  async function openFolder(dir: string) {
    setThreads([{ id: "main", name: "Thread 1" }]);
    setActiveThread("main");
    nextThread.current = 2;
    for (const t of tabs.tabs) disposeDoc(t.path);
    dispatch({ type: "reset" });
    setCounts({});
    setServers({});
    await lsp.current.setRoot(dir);
    setRoot(dir);
    setView("editor");
    rootRef.current = dir;
    const svc = await createWorkspaceServices({
      root: dir,
      mode: () => loadSettings().reviewMode,
      onChange: () => setVersion((v) => v + 1),
      onReport: (e) => setReport(e),
      onHook: (event, output) => setNotice(`${event} hook: ${output.slice(0, 300)}`),
      ask: (req) => new Promise<Remember>((resolve) => setPermissions((q) => [...q, { req, resolve }])),
      diagnostics: async (files) => errorMarkers(dir, files),
      askQuestions: (questions) => new Promise<string[]>((resolve) => setQuestionReq({ questions, resolve })),
      askAddFile: (question, path) => new Promise<boolean>((resolve) => setAddFileReq({ question, path, resolve })),
      onPlanWritten: (slug) => {
        setActivePlan(slug);
        setView("plan");
      },
      onBlocked: (path, message) => setNotice(message),
      onMemoryCreated: (name, body) => setNotice(`The agent saved a memory: ${name} - ${body.slice(0, 160)}. Review it under Context > Memories.`),
    });
    setServices(svc);
    if (svc.hookErrors.length) setNotice(`.forge/hooks.json: ${svc.hookErrors.join("; ")}`);
    void svc.proposeCommandsSection().catch(() => {});
    void svc.plans.list().then((l) => setActivePlan(l[0]?.slug ?? null));
    setIndexInfo({ progress: "starting" });
    const st = loadSettings();
    indexApi
      .start(dir, st.embedModel, st.embedUrl)
      .then((which) => which.includes("unavailable") && setNotice(`Semantic search is using the ${which}`))
      .catch((e) => setNotice(`Indexer failed: ${e}`));
  }

  /** After agent runs, accepts and rollbacks: pull changed files from disk into open editors. */
  const refreshFromDisk = useCallback(async () => {
    const changed = await reloadOpenDocs();
    for (const path of changed) dispatch({ type: "dirty", path, dirty: false });
    setVersion((v) => v + 1);
  }, []);

  /** Execute an approved plan step by step (explicit Build action, or a plain "go"). */
  async function startBuild(slug: string) {
    if (!services || building) return;
    setBuilding(true);
    setActivePlan(slug);
    setView("plan");
    const ctl = new AbortController();
    buildAbort.current = ctl;
    services.planGuard.activate(slug);
    const failedChecks = (r?: { checks: { ok: boolean; skipped?: string }[] }) => !!r && r.checks.some((c) => !c.ok && !c.skipped);
    const executor = new PlanExecutor({
      store: services.plans,
      signal: ctl.signal,
      beginChangeSet: (label, n) => {
        services.pending.beginChangeSet(label, n);
        services.planGuard.setStep(n);
      },
      runStep: async (_step, prompt) => {
        const outcome = await sendRef.current(prompt, "agent");
        if (outcome.error) return { ok: false, reason: outcome.error };
        if (outcome.limit) return { ok: false, reason: `stopped: ${outcome.limit}` };
        // Review mode: the step is not done until the developer has resolved its pending changes.
        while (services.pending.list().length > 0 && !ctl.signal.aborted) await new Promise((r) => setTimeout(r, 300));
        if (failedChecks(outcome.report)) return { ok: false, reason: "checks failed" };
        if (!outcome.report || outcome.report.summary.includes("pending")) {
          const r = await services.runVerification("full");
          if (failedChecks(r)) return { ok: false, reason: "checks failed after your review" };
        }
        return { ok: true };
      },
    });
    try {
      const res = await executor.build(slug);
      setNotice(res.status === "done" ? "Plan complete." : res.status === "failed" ? `Plan paused: step ${res.step} failed${res.reason ? ` (${res.reason})` : ""}.` : "Plan paused.");
    } catch (e) {
      setNotice(`Build failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      services.planGuard.deactivate();
      setBuilding(false);
      void refreshFromDisk();
    }
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
      { id: "welcome", title: "Help: Welcome and privacy setup", run: () => setWelcome(true) },
      { id: "context", title: "View: Context (rules, memories, docs)", keybinding: "Ctrl+Shift+K", run: () => setView((v) => (v === "context" ? "editor" : "context")) },
      { id: "plan", title: "View: Show Plan", keybinding: "Ctrl+Shift+L", run: () => setView((v) => (v === "plan" ? "editor" : "plan")) },
      { id: "review", title: "View: Review Pending Changes", keybinding: "Ctrl+Shift+R", run: () => setView((v) => (v === "review" ? "editor" : "review")) },
      { id: "agent-panel", title: "View: Toggle Agent Panel", keybinding: "Ctrl+L", run: () => setAgentOpen((o) => !o) },
      { id: "theme", title: "View: Toggle Light/Dark Theme", run: () => setDark((d) => !d) },
    ],
    [chooseFolder, save, closeTab, tabs.active],
  );

  async function runInline(instruction: string) {
    if (!inline || !services) return;
    const { ctx } = inline;
    setInline({ ctx, busy: true, done: null });
    try {
      const st = loadSettings();
      const reply = await completeOnce({ ...st, apiKey: await loadApiKey(st.provider) }, services, buildInlinePrompt(ctx, instruction));
      const replacement = extractReplacement(reply);
      if (replacement.trim() === "" && ctx.start === ctx.end) throw new Error("the model returned nothing to insert");
      const out = await services.pending.propose(ctx.path, spliceSelection(ctx.text, ctx.start, ctx.end, replacement), `Inline edit: ${instruction}`);
      setInline({ ctx, busy: false, done: out.status === "pending" ? "Proposed: review it from the pending-changes banner." : `Done (${out.status}).` });
    } catch (e) {
      setNotice(`Inline edit failed: ${e instanceof Error ? e.message : String(e)}`);
      setInline(null);
    }
  }

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
    // Capture phase: app shortcuts must win over the editor's own bindings (e.g. Monaco uses Ctrl+Shift+K and Ctrl+L).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [commands]);

  const pendingFiles = services ? services.pending.list() : [];
  // Inline green/red decorations for pending changes on the active file (updates as proposals stream in).
  useEffect(() => {
    if (!services) return;
    for (const t of tabs.tabs) {
      const pf = services.pending.get(norm(t.path));
      if (pf && !pf.conflict) {
        showPendingDecorations(t.path, pf.hunks.filter((h) => !pf.resolved[h.id]).map((h) => ({ oldStart: h.oldStart, oldCount: h.oldLines.length, added: h.newLines })));
      } else clearPendingDecorations(t.path);
    }
  }, [services, version, tabs.tabs, tabs.active]);

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
          {inline && (
            <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-sm" data-testid="inline-edit">
              <span className="shrink-0 text-[var(--muted)]">{inline.ctx.start === inline.ctx.end ? "Insert at cursor:" : "Edit selection:"}</span>
              {inline.done ? (
                <>
                  <span data-testid="inline-done">{inline.done}</span>
                  <button className="ml-auto underline" onClick={() => setInline(null)}>Close</button>
                </>
              ) : (
                <>
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-0.5"
                    data-testid="inline-instruction"
                    aria-label="Describe the change"
                    placeholder="Describe the change, then Enter (Esc to cancel)"
                    disabled={inline.busy}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setInline(null);
                      if (e.key === "Enter" && e.currentTarget.value.trim() && !inline.busy) void runInline(e.currentTarget.value.trim());
                    }}
                  />
                  {inline.busy && <span className="text-[var(--muted)]">Working…</span>}
                </>
              )}
            </div>
          )}
          {view === "review" && services && (
            <div className="min-h-0 flex-1">
              <ReviewPane
                pending={services.pending}
                root={services.root}
                version={version}
                onResolved={() => void refreshFromDisk()}
                onRevise={(prompt) => void sendRef.current(prompt, "agent")}
                onClose={() => setView("editor")}
                report={report?.report ?? null}
              />
            </div>
          )}
          {view === "plan" && services && (
            <div className="min-h-0 flex-1">
              <PlanPane
                services={services}
                version={version}
                slug={activePlan}
                building={building}
                onSelect={setActivePlan}
                onBuild={(slug) => void startBuild(slug)}
                onPause={() => buildAbort.current?.abort()}
                onEditFile={(p) => {
                  setView("editor");
                  void openFile(p);
                }}
                onClose={() => setView("editor")}
              />
            </div>
          )}
          {view === "context" && services && (
            <div className="min-h-0 flex-1">
              <ContextPane
                services={services}
                version={version}
                activeFile={tabs.active ? norm(tabs.active).replace(norm(services.root) + "/", "") : null}
                onOpenFile={(rel) => {
                  setView("editor");
                  void openFile(`${services.root}/${rel}`);
                }}
                onClose={() => setView("editor")}
              />
            </div>
          )}
          <div className={`min-h-0 flex-1 ${view !== "editor" ? "hidden" : ""}`}>
            <Editor
              path={tabs.active}
              dark={dark}
              onDirty={(path, dirty) => dispatch({ type: "dirty", path, dirty })}
              onChange={(path, language, snapshot) => {
                clearTimeout(lspTimers.current.get(path));
                lspTimers.current.set(path, setTimeout(() => { const { version, text } = snapshot(); void lsp.current.change(path, language, version, text); }, 200));
              }}
              onCursor={(l, c) => setCursor([l, c])}
              onInlineEdit={(ctx) => {
                const d = getDoc(ctx.path);
                if (d && isDirty(d)) return setNotice("Save the file first (Ctrl+S): inline edits are proposed against the saved version.");
                setNotice(null);
                setInline({ ctx, busy: false, done: null });
              }}
            />
          </div>
          {terminalEverOpened && (
            <div className={`h-64 border-t border-[var(--border)] ${terminalOpen ? "" : "hidden"}`}>
              <Terminal cwd={root} visible={terminalOpen} dark={dark} />
            </div>
          )}
        </section>
        {agentOpen && (
          <div className="flex min-h-0 flex-col" data-testid="agent-area">
            <div className="flex items-center gap-1 border-b border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs">
              <div role="tablist" aria-label="Agent threads" className="flex items-center gap-1">
                {threads.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={t.id === activeThread}
                    data-testid={`thread-tab-${t.id}`}
                    className={`rounded px-2 py-0.5 ${t.id === activeThread ? "bg-[var(--hover)] font-semibold" : "text-[var(--muted)]"}`}
                    onClick={() => setActiveThread(t.id)}
                  >
                    {t.name}
                    {busyThreads[t.id] ? <span aria-label="running" title="running"> ●</span> : null}
                  </button>
                ))}
              </div>
              <button
                aria-label="New thread"
                title="Start another agent thread that runs in parallel"
                data-testid="thread-new"
                className="rounded px-2 py-0.5 text-[var(--muted)] hover:bg-[var(--hover)]"
                onClick={() => {
                  const id = `t${nextThread.current}`;
                  setThreads((ts) => [...ts, { id, name: `Thread ${nextThread.current++}` }]);
                  setActiveThread(id);
                }}
              >
                +
              </button>
              {activeThread !== "main" && !busyThreads[activeThread] && (
                <button
                  className="ml-auto rounded px-2 py-0.5 text-[var(--muted)] hover:bg-[var(--hover)]"
                  data-testid={`thread-close-${activeThread}`}
                  onClick={() => {
                    const id = activeThread;
                    setThreads((ts) => ts.filter((x) => x.id !== id));
                    setActiveThread("main");
                  }}
                >
                  Close thread
                </button>
              )}
            </div>
            {threads.map((t) => (
              <div key={t.id} className={t.id === activeThread ? "flex min-h-0 flex-1 flex-col [&>aside]:min-h-0 [&>aside]:flex-1" : "hidden"}>
                <AgentPanel
                  threadId={t.id}
                  active={t.id === activeThread}
                  onBusyChange={(b) => threadBusy(t.id, b)}
                  root={root}
                  activePath={tabs.active}
                  services={services}
                  pendingCount={pendingFiles.length}
                  version={version}
                  onOpenReview={() => setView("review")}
                  onFilesChanged={() => void refreshFromDisk()}
                  registerSend={registerSend}
                  activePlanSlug={activePlan}
                  onStartBuild={(slug) => void startBuild(slug)}
                  externalReport={report}
                  onReport={setReport}
                  onHook={(event, output) => setNotice(`${event} hook: ${output.slice(0, 300)}`)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <footer className="flex gap-4 border-t border-[var(--border)] bg-[var(--panel)] px-3 py-0.5 text-xs text-[var(--muted)]" data-testid="status">
        <span>{root ?? "No folder open"}</span>
        <span data-testid="index-status" title={indexInfo.status ? `${indexInfo.status.symbols} symbols, ${indexInfo.status.chunks} chunks` : ""}>
          {indexInfo.progress ? `Indexing: ${indexInfo.progress}` : indexInfo.status ? `Indexed ${indexInfo.status.indexed_files} files` : ""}
        </span>
        <span data-testid="safety-status" title="Agent commands run in the sandbox; local-only blocks every request that would leave this machine">
          sandbox: {sandboxMode || "?"}
          {localOnly ? " · local-only" : ""}
        </span>
        {building && <span data-testid="building" className="text-blue-400">Building plan…</span>}
        {pendingFiles.length > 0 && (
          <button className="text-amber-400 underline" data-testid="pending-count" onClick={() => setView("review")}>
            {pendingFiles.length} pending
          </button>
        )}
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
      {questionReq && (
        <QuestionPrompt
          questions={questionReq.questions}
          onAnswer={(a) => {
            questionReq.resolve(a);
            setQuestionReq(null);
          }}
        />
      )}
      {addFileReq && (
        <AddFilePrompt
          question={addFileReq.question}
          path={addFileReq.path}
          onAnswer={(b) => {
            addFileReq.resolve(b);
            setAddFileReq(null);
          }}
        />
      )}
      {welcome && <Welcome onDone={() => setWelcome(false)} onOpenFolder={() => void chooseFolder()} />}
      {permission && (
        <PermissionPrompt
          req={permission.req}
          onAnswer={(a) => {
            permission.resolve(a);
            setPermissions((q) => q.slice(1));
          }}
        />
      )}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
