import { useEffect, useRef, useState } from "react";
import type { Mode } from "@forge/protocol";
import type { Message } from "@forge/protocol";
import type { MeterEntry, ContextSection } from "@forge/agent-runtime";
import type { AgentRuntime } from "@forge/agent-runtime/src/remote";
import { createSession } from "../lib/agentSession";
import { fsApi, indexBackend } from "../lib/ipc";
import { attachmentKey, attachmentLabel, resolveAttachment, type Attachment } from "../lib/attachments";
import { RuleEngine, detectCorrection, renderMemories, selectMemories, suggestNewThread, stringifyFrontmatter, type Correction, type SessionRecord, type SavedPrompt, expandPrompt, matchPrompts, skillsIndex } from "@forge/context-store";
import { terminalRegistry } from "../lib/terminalRegistry";
import { fetchText } from "../lib/http";
import { loadApiKey, migrateLegacyKey, storeApiKey } from "../lib/secrets";
import { mark } from "../lib/trace";
import { Markdown } from "./Markdown";
import { prewarmRuntime } from "../lib/runtimeProcess";
import { DEFAULT_MODELS, loadSettings, saveSettings, sendsCodeOffMachine, type AgentSettings } from "../lib/settings";
import { completeOnce } from "../lib/agentSession";
import type { WorkspaceServices } from "../lib/workspace";
import { Timeline } from "./Timeline";
import { classifyIntent, looksLarge } from "@forge/plans";
import { ReportCard } from "./ReportCard";
import type { VerificationReport } from "@forge/verify";
import { git, type ReportEvent } from "../lib/workspace";

const MODES: Mode[] = ["ask", "plan", "agent", "debug"];

/**
 * Put `next` where the streaming placeholder is. An empty placeholder is replaced; one that already holds narration
 * ("Looking at the file...") is kept, and `next` goes after it, so the agent's words are never lost.
 */
function replaceLastAssistant(items: Item[], next: Item[]): Item[] {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === "assistant") return it.text.trim() === "" ? [...items.slice(0, k), ...next, ...items.slice(k + 1)] : [...items.slice(0, k + 1), ...next, ...items.slice(k + 1)];
  }
  return [...items, ...next];
}

export interface RunOutcome {
  /** the run stopped on a limit (steps, cost, verify, aborted) */
  limit?: string;
  /** last verification report produced during the run */
  report?: VerificationReport;
  error?: string;
}

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; ok: boolean; output: string; id?: string }
  | { kind: "notice"; text: string }
  | { kind: "report"; report: VerificationReport; source: string }
  | { kind: "injection"; tool: string; findings: { pattern: string; excerpt: string }[] }
  | { kind: "compaction"; summary: string; removed: number; before: number; after: number };

interface Props {
  root: string | null;
  activePath: string | null;
  services: WorkspaceServices | null;
  pendingCount: number;
  /** bumps when pending changes or checkpoints change */
  version: number;
  onOpenReview: () => void;
  /** called after a run or a restore so the editor can refresh files from disk */
  onFilesChanged: () => void;
  /** lets other UI (review comments) send a prompt through the agent */
  registerSend: (fn: (prompt: string, mode?: Mode) => Promise<RunOutcome>) => void;
  /** slug of the plan currently shown, if any */
  activePlanSlug: string | null;
  /** start executing a plan (explicit Build action or a clear "go") */
  onStartBuild: (slug: string) => void;
  /** reports produced outside a run (accepted changes, manual "Run checks") */
  externalReport: ReportEvent | null;
  onReport: (e: ReportEvent) => void;
  onHook: (event: string, output: string) => void;
  /** parallel threads: each panel is its own conversation and runtime */
  threadId?: string;
  /** only the visible thread receives review-comment sends */
  active?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /** this thread works in its own git worktree (no shared code index) */
  isolated?: boolean;
}

const FIELD = "min-w-0 flex-1 rounded bg-[var(--hover)] px-1 py-0.5";

function SettingsHeading({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return <h3 className={`${first ? "" : "mt-3 border-t border-[var(--border)] pt-2"} text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]`}>{children}</h3>;
}

/** A label and its control(s) on one aligned row. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
      <span>{label}</span>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
    </label>
  );
}

function Check({ checked, onChange, testId, children }: { checked: boolean; onChange: (v: boolean) => void; testId?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-0.5" data-testid={testId} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function AgentPanel({ root, activePath, services, pendingCount, version, onOpenReview, onFilesChanged, registerSend, externalReport, onReport, onHook, activePlanSlug, onStartBuild, threadId = "main", active = true, onBusyChange, isolated = false }: Props) {
  const [settings, setSettings] = useState<AgentSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [mode, setMode] = useState<Mode>("ask");
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [chips, setChips] = useState<Attachment[]>([]);
  const [attachKind, setAttachKind] = useState<Attachment["kind"] | "">("");
  const [attachArg, setAttachArg] = useState("");
  const [busy, setBusy] = useState(false);
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [meter, setMeter] = useState<{ total: number; entries: MeterEntry[]; calibrated: boolean } | null>(null);
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [newThread, setNewThread] = useState<string | null>(null);
  const [resumable, setResumable] = useState<SessionRecord | null>(null);
  const promptsRef = useRef<string[]>([]);
  const promptRef = useRef("");
  const planRef = useRef<string | null>(null);
  const pendingHistory = useRef<Message[] | null>(null);
  const [cost, setCost] = useState(0);
  const [runtimeKind, setRuntimeKind] = useState("");
  const [auditTick, setAuditTick] = useState(0);
  const [auditFilter, setAuditFilter] = useState<"all" | "network" | "command" | "file" | "blocked">("all");
  const [showAudit, setShowAudit] = useState(false);
  const [external, setExternal] = useState<string | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const [suggest, setSuggest] = useState<string | null>(null);
  const runtime = useRef<AgentRuntime | null>(null);
  const abort = useRef<AbortController | null>(null);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;
  planRef.current = activePlanSlug;
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [items]);
  useEffect(() => {
    if (services) void services.prompts().then(setPrompts).catch(() => setPrompts([]));
  }, [services, version]);
  useEffect(() => {
    runtime.current?.terminate?.();
    runtime.current = null; // new workspace or settings: build a fresh session on next send
  }, [root, settings]);
  useEffect(() => () => runtime.current?.terminate?.(), []); // closing a thread releases its worker/process
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    setResumable(null);
    if (services && threadId === "main") void services.sessions.latest().then((r) => setResumable(r && r.messages.length > 0 ? r : null)).catch(() => {});
  }, [services]);

  useEffect(() => {
    if (services) services.audit.onEntry(() => setAuditTick((t) => t + 1));
  }, [services]);

  const seenReport = useRef(0);
  useEffect(() => {
    if (externalReport && externalReport.seq !== seenReport.current) {
      seenReport.current = externalReport.seq;
      setItems((i) => [...i, { kind: "report", report: externalReport.report, source: externalReport.source === "accepted-changes" ? "after you accepted changes" : "manual" }]);
    }
  }, [externalReport]);

  // The API key lives in the OS credential store: load it for the current provider (after migrating any old copy).
  useEffect(() => {
    void migrateLegacyKey().then(() => loadApiKey(settings.provider)).then((k) => setSettings((cur) => (cur.apiKey === k ? cur : { ...cur, apiKey: k })));
  }, [settings.provider]);

  const update = (patch: Partial<AgentSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    if (patch.apiKey !== undefined) void storeApiKey(next.provider, patch.apiKey);
  };

  async function send(override?: { prompt: string; mode?: Mode; skipSuggest?: boolean }): Promise<RunOutcome> {
    const outcome: RunOutcome = {};
    let prompt = (override?.prompt ?? input).trim();
    // A saved prompt (.forge/prompts/<name>.md) invoked as /name args: send what it expands to.
    const slash = !override ? expandPrompt(prompt, prompts) : null;
    if (slash) prompt = slash.prompt;
    const runMode = override?.mode ?? mode;
    if (!prompt || busy || !root || !services) return outcome;
    if (!override && external) return runExternal(prompt);

    // Only the explicit Build action or a plain, unqualified "go" starts execution; ambiguous wording never does.
    if (!override && activePlanSlug) {
      const intent = classifyIntent(prompt);
      if (intent === "build") {
        setInput("");
        setItems((i) => [...i, { kind: "user", text: prompt }]);
        onStartBuild(activePlanSlug);
        return outcome;
      }
      if (intent === "ambiguous") {
        setItems((i) => [...i, { kind: "user", text: prompt }, { kind: "notice", text: "That could mean two different things, so nothing was executed. Use the Build button, or send just \"go\"." }]);
        setInput("");
        return outcome;
      }
    }
    // A different task after a few turns: suggest a fresh thread (carries over the plan and memories).
    if (!override && newThread !== prompt && runtime.current && suggestNewThread(promptsRef.current, prompt)) {
      setNewThread(prompt);
      return outcome;
    }
    setNewThread(null);
    // Large-looking requests: suggest Plan mode first.
    if (!override && runMode !== "plan" && runMode !== "debug" && suggest !== prompt && looksLarge(prompt)) {
      setSuggest(prompt);
      return outcome;
    }
    setSuggest(null);
    if (!override) {
      setInput("");
      setCorrection(detectCorrection(prompt)); // offered, never saved silently
    }
    promptRef.current = prompt;
    promptsRef.current.push(prompt);
    setBusy(true);
    setItems((i) => [...i, { kind: "user", text: prompt }, { kind: "assistant", text: "" }]);
    mark("send: start");
    let began = false;
    try {
      // If the process behind the last session died, start a fresh one and carry the conversation over.
      const carried = runtime.current?.isDead ? runtime.current.history : null;
      if (!runtime.current || runtime.current.isDead) {
        runtime.current = await createSession({
          isolated,
          root,
          settings,
          services,
          onHook: (event, output) => onHook(event, output),
          sections: async () => {
            const out: ContextSection[] = [];
            mark("sections: start");
            const slash = (p: string) => p.split("\\").join("/");
            const rel = (p: string) => slash(p).replace(slash(root!) + "/", "");
            const fileChips = chipsRef.current.filter((c) => c.kind === "file").map((c) => rel(c.arg));
            const focus = [...fileChips, ...(activeRef.current ? [rel(activeRef.current)] : [])];

            // Rules for the files in play, in precedence order, plus an index of rules the model may load.
            try {
              services.rules.invalidate();
              const mentioned = chipsRef.current.filter((c) => c.kind === "rule").map((c) => c.arg);
              const applied = await services.rules.applicable(focus, { mentioned });
              const choosable = await services.rules.agentChoosable(applied);
              const parts = [RuleEngine.render(applied), choosable.length ? `Available rules (load with get_rule when relevant): ${choosable.map((r) => `${r.name}: ${r.description ?? ""}`).join("; ")}` : ""].filter(Boolean);
              if (parts.length) out.push({ id: "rules", label: "Project rules", priority: 0, text: parts.join("\n\n") });
            } catch {
              /* rules unreadable: continue without them */
            }
            // The approved plan stays in context verbatim.
            if (planRef.current) {
              const p = await services.plans.read(planRef.current).catch(() => null);
              if (p) out.push({ id: "plan", label: "Active plan", priority: 1, text: p.md });
            }
            // Saved memories relevant to this request.
            try {
              const mems = selectMemories(await services.memories.list(), promptRef.current);
              if (mems.length) out.push({ id: "memories", label: "Memories (preferences the developer saved)", priority: 1, text: renderMemories(mems) });
            } catch {
              /* ignore */
            }
            // Attachments (chips).
            const backends = {
              readFile: fsApi.readFile,
              listDir: fsApi.listDir,
              symbol: indexBackend.symbol,
              gitDiff: async () => (await git(root!, ["diff"])).stdout,
              terminalText: () => terminalRegistry.read(),
              fetchText,
              docs: services.docs,
              rules: services.rules,
              memories: () => services.memories.list(),
              root: slash(root!),
            };
            for (const att of chipsRef.current) {
              try {
                const sec = await resolveAttachment(att, backends, promptRef.current);
                if (sec) out.push(sec);
              } catch {
                /* vanished file, offline page, ...: skip */
              }
            }
            try {
              const skills = await services.skills();
              if (skills.length) out.push({ id: "skills", label: "Skills available (load one with use_skill before a task it covers)", priority: 3, text: skillsIndex(skills) });
            } catch {
              /* no skills folder */
            }
            try {
              const map = isolated ? null : await indexBackend.repoMap(focus, 1500); // the index describes the main checkout
              if (map) out.push({ id: "repo-map", label: "Repo map (ranked by relevance to your open files)", priority: 3, text: map });
            } catch {
              /* index not ready yet: the agent can still use grep/read tools */
            }
            mark("sections: done");
            return out;
          },
        });
      }
      mark("send: session ready");
      const rt = runtime.current;
      if (carried?.length) rt.setHistory(carried);
      setRuntimeKind(rt.transport ?? "");
      services.setRuntime(rt); // the runtime acting now: checkpoints record its history length
      services.runBegin();
      began = true;
      if (pendingHistory.current) {
        rt.setHistory([...rt.history, ...pendingHistory.current]);
        pendingHistory.current = null;
      }
      abort.current = new AbortController();
      mark("send: run() called");
      for await (const ev of rt.run({ mode: runMode, prompt, signal: abort.current.signal })) {
        if (ev.type === "text") {
          setItems((i) => {
            // A notice may have been appended mid-stream; always extend the last assistant item, wherever it is.
            for (let k = i.length - 1; k >= 0; k--) {
              const it = i[k]!;
              if (it.kind === "assistant") return [...i.slice(0, k), { kind: "assistant", text: it.text + ev.delta }, ...i.slice(k + 1)];
            }
            return i;
          });
        } else if (ev.type === "tool_result") {
          setItems((i) => replaceLastAssistant(i, [{ kind: "tool", name: ev.name, ok: ev.result.ok, output: ev.result.output }, { kind: "assistant", text: "" }]));
        } else if (ev.type === "verify") {
          const report = ev.report as VerificationReport;
          outcome.report = report;
          setItems((i) => replaceLastAssistant(i, [{ kind: "report", report, source: "agent run" }, { kind: "assistant", text: "" }]));
          const seq = Date.now() + Math.random(); // already shown inline; mark it seen so the effect below does not add it twice
          seenReport.current = seq;
          onReport({ report, source: "agent", seq });
        } else if (ev.type === "injection") {
          setItems((i) => replaceLastAssistant(i, [{ kind: "injection", tool: ev.tool, findings: ev.findings }, { kind: "assistant", text: "" }]));
        } else if (ev.type === "compaction") {
          setItems((i) => replaceLastAssistant(i, [{ kind: "compaction", summary: ev.summary, removed: ev.removedMessages, before: ev.tokensBefore, after: ev.tokensAfter }, { kind: "assistant", text: "" }]));
        } else if (ev.type === "hook") {
          if (ev.output) onHook(ev.event, ev.output);
        } else if (ev.type === "limit") {
          outcome.limit = ev.reason;
          setItems((i) => [...i, { kind: "notice", text: ev.reason === "verify" ? "Stopped: checks kept failing, see the report above." : `Stopped: ${ev.reason} limit reached.` }]);
        }
      }
      setCost(rt.costUsd);
      const m = rt.meter();
      setMeter({ total: m.total, entries: m.entries, calibrated: m.calibrated });
      void services.sessions.save({ id: threadId === "main" ? services.sessionId : `${services.sessionId}-${threadId}`, savedAt: new Date().toISOString(), messages: rt.history, summaries: rt.summaries }).catch(() => {});
    } catch (e) {
      outcome.error = e instanceof Error ? e.message : String(e);
      setItems((i) => [...i, { kind: "notice", text: `Error: ${outcome.error}` }]);
    } finally {
      if (began) services.runEnd();
      setItems((i) => i.filter((x) => !(x.kind === "assistant" && x.text === "")));
      setBusy(false);
      onFilesChanged();
    }
    return outcome;
  }
  /** One prompt through an external ACP agent. Its file edits arrive as pending changes in the review UI. */
  async function runExternal(prompt: string): Promise<RunOutcome> {
    const outcome: RunOutcome = {};
    if (!services || !external) return outcome;
    setInput("");
    setBusy(true);
    setItems((i) => [...i, { kind: "user", text: prompt }, { kind: "assistant", text: "" }]);
    abort.current = new AbortController();
    try {
      const r = await services.acp.prompt(
        external,
        prompt,
        (u) => {
          if (u.kind === "message") {
            setItems((i) => {
              for (let k = i.length - 1; k >= 0; k--) {
                const it = i[k]!;
                if (it.kind === "assistant") return [...i.slice(0, k), { kind: "assistant", text: it.text + u.text }, ...i.slice(k + 1)];
              }
              return i;
            });
          } else if (u.kind === "tool_call") {
            setItems((i) => replaceLastAssistant(i, [{ kind: "tool", id: u.id, name: `${external}: ${u.title}`, ok: u.status !== "failed", output: u.status }, { kind: "assistant", text: "" }]));
          } else if (u.kind === "tool_call_update") {
            setItems((i) => i.map((it) => (it.kind === "tool" && it.id === u.id ? { ...it, ok: u.status !== "failed", output: [u.status, u.text].filter(Boolean).join(": ") } : it)));
          } else if (u.kind === "plan") {
            setItems((i) => replaceLastAssistant(i, [{ kind: "notice", text: `${external} plan: ${u.entries.map((e) => `${e.status === "completed" ? "[x]" : "[ ]"} ${e.content}`).join("; ")}` }, { kind: "assistant", text: "" }]));
          }
        },
        abort.current.signal,
      );
      setItems((i) => [...i, { kind: "notice", text: `${external} finished (${r.stopReason}). Its edits are in the review pane.` }]);
    } catch (e) {
      outcome.error = e instanceof Error ? e.message : String(e);
      setItems((i) => [...i, { kind: "notice", text: `Error: ${outcome.error}` }]);
    } finally {
      setItems((i) => i.filter((x) => !(x.kind === "assistant" && x.text === "")));
      setBusy(false);
      onFilesChanged();
    }
    return outcome;
  }

  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!active) return;
    registerSend(async (prompt, m) => {
      setMode(m ?? "agent");
      return sendRef.current({ prompt, mode: m ?? "agent" });
    });
  }, [registerSend, active]);

  const offMachine = sendsCodeOffMachine(settings);
  const category = (id: string) => (id === "system" || id === "mode" ? "System prompt" : id === "rules" ? "Rules" : id === "memories" ? "Memories" : id === "plan" ? "Plan" : id === "repo-map" ? "Repo map" : id === "conversation" ? "Conversation" : "Attachments");
  const byCategory = new Map<string, number>();
  for (const e of meter?.entries ?? []) byCategory.set(category(e.id), (byCategory.get(category(e.id)) ?? 0) + e.tokens);
  const breakdown = [...byCategory].map(([k, v]) => `${k}: ${v.toLocaleString()}`).join("\n") + (meter ? `\n(${meter.calibrated ? "calibrated against the provider counts" : "estimate"})` : "");

  return (
    <aside className="flex h-full w-96 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]" aria-label="Agent panel" data-testid="agent-panel">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-sm">
        <strong>Agent</strong>
        <select
          aria-label="Mode"
          data-testid="mode-select"
          className="rounded bg-[var(--hover)] px-1"
          value={external ? `ext:${external}` : mode}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("ext:")) setExternal(v.slice(4));
            else {
              setExternal(null);
              setMode(v as Mode);
            }
          }}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
          {(services?.acp.agents ?? []).map((a) => (
            <option key={a.name} value={`ext:${a.name}`}>external: {a.name}</option>
          ))}
        </select>
        <span className={`ml-auto text-xs ${offMachine ? "text-amber-400" : "text-green-400"}`} data-testid="privacy-badge" title={offMachine ? "Prompts and attached code are sent to a remote server" : "Local model: nothing leaves this machine"}>
          {offMachine ? "remote" : "local"}
        </span>
        <button className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--hover)]" data-testid="timeline-toggle" onClick={() => { setShowTimeline((s) => !s); setShowAudit(false); }}>Checkpoints</button>
        <button className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--hover)]" onClick={() => { setShowAudit((s) => !s); setShowTimeline(false); }}>Audit</button>
        <button className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--hover)]" aria-pressed={showSettings} onClick={() => setShowSettings((s) => !s)} data-testid="settings-toggle">Settings</button>
      </header>

      {showSettings && (
        <div className="max-h-[60vh] space-y-1 overflow-auto border-b border-[var(--border)] p-3 text-xs" data-testid="settings">
          <SettingsHeading first>Model</SettingsHeading>
          <Row label="Provider">
            <select className="rounded bg-[var(--hover)] px-1 py-0.5" value={settings.provider} onChange={(e) => update({ provider: e.target.value as AgentSettings["provider"], model: DEFAULT_MODELS[e.target.value as AgentSettings["provider"]] })}>
              <option value="ollama">Ollama (local)</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </Row>
          <Row label="Model"><input className={FIELD} value={settings.model} onChange={(e) => update({ model: e.target.value })} /></Row>
          <Row label="Base URL"><input data-testid="base-url" className={FIELD} placeholder="default" value={settings.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} /></Row>
          <Row label="API key"><input type="password" className={FIELD} value={settings.apiKey} onChange={(e) => update({ apiKey: e.target.value })} /></Row>
          <p className="text-[var(--muted)]">The API key is stored in your OS credential store, not in a file or local storage.</p>

          <SettingsHeading>Edits and limits</SettingsHeading>
          <Row label="Edits">
            <select data-testid="review-mode" className="rounded bg-[var(--hover)] px-1 py-0.5" value={settings.reviewMode} onChange={(e) => update({ reviewMode: e.target.value as AgentSettings["reviewMode"] })}>
              <option value="review">Review every edit</option>
              <option value="plan-files">Auto-apply files in the plan</option>
              <option value="auto">Auto-apply everything (checkpointed)</option>
            </select>
          </Row>
          <Row label="Max steps"><input type="number" className="w-16 rounded bg-[var(--hover)] px-1 py-0.5" value={settings.maxSteps} onChange={(e) => update({ maxSteps: Number(e.target.value) || 12 })} /><span className="text-[var(--muted)]">Max $</span><input type="number" step="0.5" className="w-16 rounded bg-[var(--hover)] px-1 py-0.5" value={settings.maxCostUsd} onChange={(e) => update({ maxCostUsd: Number(e.target.value) || 2 })} /></Row>
          <Row label="Max minutes"><input type="number" className="w-16 rounded bg-[var(--hover)] px-1 py-0.5" value={Math.round(settings.maxSeconds / 60)} onChange={(e) => update({ maxSeconds: (Number(e.target.value) || 30) * 60 })} /><span className="text-[var(--muted)]">per run</span></Row>
          <Row label="Context"><input type="number" data-testid="budget-tokens" className="w-24 rounded bg-[var(--hover)] px-1 py-0.5" value={settings.budgetTokens} onChange={(e) => update({ budgetTokens: Number(e.target.value) || 100000 })} /><span className="text-[var(--muted)]">tokens, compact at</span><input type="number" step="0.05" min="0.3" max="0.95" className="w-14 rounded bg-[var(--hover)] px-1 py-0.5" value={settings.compactionThreshold} onChange={(e) => update({ compactionThreshold: Number(e.target.value) || 0.8 })} /></Row>

          <SettingsHeading>Privacy and safety</SettingsHeading>
          <Check testId="local-only" checked={settings.localOnly} onChange={(v) => update({ localOnly: v })}>Local-only mode: block every request that would leave this machine</Check>
          <Check testId="sandbox-on" checked={settings.sandbox} onChange={(v) => update({ sandbox: v })}>Run agent commands in the OS sandbox (workspace only, no network)</Check>
          <Check checked={settings.toolchainRead} onChange={(v) => update({ toolchainRead: v })}>Let the sandbox read tool folders on PATH (adds read-only access for node, git, ...)</Check>

          <SettingsHeading>Assistance</SettingsHeading>
          <Check testId="completions-toggle" checked={settings.completions} onChange={(v) => update({ completions: v })}>Ghost-text completions while typing (sends the code around your cursor to the model every time you pause{sendsCodeOffMachine(settings) ? "; this provider is NOT on this machine" : ""})</Check>
          {settings.completions && (
            <Row label="Completion model"><input className={FIELD} data-testid="completion-model" placeholder={settings.model} value={settings.completionModel} onChange={(e) => update({ completionModel: e.target.value })} /></Row>
          )}
          <Check testId="auto-memories" checked={settings.autoMemories} onChange={(v) => update({ autoMemories: v })}>Let the agent create memories itself (you always see them; off by default)</Check>

          <SettingsHeading>Context</SettingsHeading>
          <Row label="Embeddings"><input className={FIELD} data-testid="embed-model" placeholder="nomic-embed-text" value={settings.embedModel} onChange={(e) => update({ embedModel: e.target.value })} /></Row>
          <p className="text-[var(--muted)]">Local Ollama model; applies on the next workspace open. Empty uses the built-in one.</p>
          <label className="block">Your rules <span className="text-[var(--muted)]">(every project, lowest precedence)</span>
            <textarea data-testid="user-rules" className="mt-1 h-16 w-full rounded bg-[var(--hover)] p-1" value={settings.userRules} onChange={(e) => update({ userRules: e.target.value })} />
          </label>
        </div>
      )}

      {pendingCount > 0 && (
        <button className="border-b border-[var(--border)] bg-amber-900/30 px-3 py-1 text-left text-xs text-amber-200" onClick={onOpenReview} data-testid="pending-banner">
          {pendingCount} file{pendingCount === 1 ? "" : "s"} with pending changes. Click to review.
        </button>
      )}
      {showTimeline && services ? (
        <div className="flex-1 overflow-auto">
          <Timeline
            services={services}
            version={version}
            onFilesChanged={onFilesChanged}
            onRestoreConversation={(n) => {
              if (runtime.current) runtime.current.setHistory(runtime.current.history.slice(0, n));
              setItems((i) => [...i, { kind: "notice", text: `Conversation restored to ${n} messages.` }]);
            }}
            draftCommitMessage={async (diff) => {
              try {
                return await completeOnce(settings, services, `Write a concise git commit message (imperative mood, max 72 char subject, optional short body) for this change. Reply with the message only.

${diff}`);
              } catch {
                return null;
              }
            }}
          />
        </div>
      ) : showAudit ? (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="audit-view">
          {(() => {
            const all = services?.audit.list() ?? [];
            const net = services?.audit.network();
            const shown = all.filter((e) => (auditFilter === "all" ? true : auditFilter === "network" ? e.kind === "network" || e.kind === "model" : auditFilter === "command" ? e.kind === "command" || e.kind === "sandbox" : auditFilter === "file" ? e.kind === "file" : !!e.blocked));
            void auditTick;
            return (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-2 py-1 text-xs">
                  {(["all", "network", "command", "file", "blocked"] as const).map((f) => (
                    <button key={f} data-testid={`audit-${f}`} className={auditFilter === f ? "underline" : "text-[var(--muted)]"} onClick={() => setAuditFilter(f)}>{f}</button>
                  ))}
                  <span className="ml-auto" data-testid="privacy-summary">
                    {net ? `${net.all.length} network request${net.all.length === 1 ? "" : "s"}, ${net.remote.length} left this machine, ${net.blocked.length} blocked` : ""}
                  </span>
                </div>
                <ul className="flex-1 overflow-auto p-2 font-mono text-xs" data-testid="audit-log">
                  {shown.length === 0 && <li className="text-[var(--muted)]">No activity yet.</li>}
                  {shown.map((a, i) => (
                    <li key={i} className={a.blocked ? "text-red-400" : ""}>{new Date(a.at).toLocaleTimeString()} {a.kind}{a.local === false ? " REMOTE" : a.local ? " local" : ""}{a.blocked ? " BLOCKED" : ""} {a.name} {a.detail}</li>
                  ))}
                </ul>
              </>
            );
          })()}
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-auto p-3 text-sm" data-testid="messages" role="log" aria-label="Conversation" tabIndex={0}>
          {items.length === 0 && <p className="text-[var(--muted)]">Ask a question about this codebase. Mode "ask" is read-only.</p>}
          {items.map((it, i) =>
            it.kind === "injection" ? (
              <div key={i} className="rounded border border-red-700 bg-red-900/20 px-2 py-1 text-xs" role="alert" data-testid="injection-warning">
                Security warning: content returned by <strong>{it.tool}</strong> contains instructions aimed at an AI ({it.findings.map((f) => f.pattern).join("; ")}). Forge treated it as data and did not follow it.
                <div className="mt-1 text-[var(--muted)]">“{it.findings[0]?.excerpt}”</div>
              </div>
            ) : it.kind === "compaction" ? (
              <details key={i} className="rounded border border-blue-700 bg-blue-900/20 px-2 py-1 text-xs" data-testid="compaction-notice">
                <summary>Context compacted: {it.removed} older messages summarised ({it.before.toLocaleString()} to {it.after.toLocaleString()} tokens). Rules, plan and file list were kept.</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{it.summary}</pre>
              </details>
            ) : it.kind === "report" ? (
              <ReportCard key={i} report={it.report} source={it.source} />
            ) : it.kind === "tool" ? (
              <details key={i} className="rounded border border-[var(--border)] px-2 py-1 text-xs" data-testid="tool-call">
                <summary>{it.ok ? "✓" : "✗"} {it.name}</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{it.output}</pre>
              </details>
            ) : (
              <div key={i} data-testid={it.kind} className={it.kind === "user" ? "rounded bg-[var(--hover)] p-2 whitespace-pre-wrap" : it.kind === "notice" ? "text-amber-400 whitespace-pre-wrap" : ""}>
                {it.kind === "assistant" ? <Markdown text={it.text} /> : it.text}
              </div>
            ),
          )}
          <div ref={bottom} />
        </div>
      )}

      {resumable && !runtime.current && items.length === 0 && (
        <div className="border-t border-[var(--border)] bg-[var(--hover)] px-3 py-2 text-xs" data-testid="resume-banner">
          A previous session ({resumable.messages.length} messages) was saved for this workspace.
          <button className="ml-2 underline" data-testid="resume-session" onClick={() => { pendingHistory.current = resumable.messages; setItems([{ kind: "notice", text: `Restored ${resumable.messages.length} messages from the previous session. They are added to your next message.` }]); setResumable(null); }}>Resume</button>
          <button className="ml-2 underline" onClick={() => setResumable(null)}>Dismiss</button>
        </div>
      )}
      {newThread && (
        <div className="border-t border-[var(--border)] bg-blue-900/30 px-3 py-2 text-xs" data-testid="newthread-banner">
          This looks like a different task. Start a new thread? It carries over the active plan and your memories, and leaves the old conversation behind.
          <div className="mt-1 flex gap-2">
            <button className="rounded bg-blue-700/70 px-2 py-0.5" data-testid="newthread-yes" onClick={() => { runtime.current?.terminate?.(); runtime.current = null; promptsRef.current = []; setItems([]); const p = newThread; setNewThread(null); void send({ prompt: p, mode }); setInput(""); }}>New thread</button>
            <button className="rounded bg-[var(--hover)] px-2 py-0.5" data-testid="newthread-no" onClick={() => { const p = newThread; void send({ prompt: p, mode }); setInput(""); }}>Continue here</button>
          </div>
        </div>
      )}
      {correction && services && (
        <div className="border-t border-[var(--border)] bg-green-900/20 px-3 py-2 text-xs" data-testid="correction-banner">
          Remember this? <em>{correction.text}</em>
          <div className="mt-1 flex flex-wrap gap-2">
            <button className="rounded bg-[var(--hover)] px-2 py-0.5" data-testid="save-memory" onClick={() => void services.memories.save({ name: correction.name, body: correction.text, scope: "project" }).then(() => { setItems((i) => [...i, { kind: "notice", text: `Saved memory "${correction.name}" to .forge/memory.` }]); setCorrection(null); })}>Save as project memory</button>
            <button className="rounded bg-[var(--hover)] px-2 py-0.5" onClick={() => void services.memories.save({ name: correction.name, body: correction.text, scope: "user" }).then(() => { setItems((i) => [...i, { kind: "notice", text: `Saved personal memory "${correction.name}".` }]); setCorrection(null); }).catch((e) => setItems((i) => [...i, { kind: "notice", text: `Could not save: ${e}` }]))}>Save as personal memory</button>
            <button className="rounded bg-[var(--hover)] px-2 py-0.5" data-testid="promote-rule" onClick={() => void services.pending.propose(`${services.root}/.forge/rules/${correction.name}.md`, stringifyFrontmatter({ description: correction.text.slice(0, 80), activation: "always" }, correction.text + "\n"), "Promote a correction to a project rule", { requireReview: true }).then(() => { setItems((i) => [...i, { kind: "notice", text: `Proposed rule .forge/rules/${correction.name}.md for review.` }]); setCorrection(null); })}>Promote to rule</button>
            <button className="underline" onClick={() => setCorrection(null)}>Dismiss</button>
          </div>
        </div>
      )}
      {suggest && (
        <div className="border-t border-[var(--border)] bg-blue-900/30 px-3 py-2 text-xs" data-testid="plan-suggestion">
          This looks like a large change. Plan first so you can review and edit the steps before any code changes?
          <div className="mt-1 flex gap-2">
            <button className="rounded bg-blue-700/70 px-2 py-0.5" data-testid="suggest-plan" onClick={() => { setMode("plan"); void send({ prompt: suggest, mode: "plan" }); setInput(""); }}>Switch to Plan mode</button>
            <button className="rounded bg-[var(--hover)] px-2 py-0.5" data-testid="suggest-continue" onClick={() => { void send({ prompt: suggest, mode, skipSuggest: true }); setInput(""); }}>Continue in {mode} mode</button>
          </div>
        </div>
      )}
      <footer className="border-t border-[var(--border)] p-2">
        <div className="mb-1 flex flex-wrap items-center gap-1" data-testid="chips">
          {chips.map((c) => (
            <span key={attachmentKey(c)} className="flex items-center gap-1 rounded bg-[var(--hover)] px-2 py-0.5 text-xs" data-testid="chip">
              {attachmentLabel(c)}
              <button aria-label={`Remove ${attachmentLabel(c)}`} onClick={() => setChips((x) => x.filter((y) => attachmentKey(y) !== attachmentKey(c)))}>×</button>
            </span>
          ))}
          {activePath && !chips.some((c) => c.kind === "file" && c.arg === activePath) && (
            <button className="rounded border border-dashed border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]" onClick={() => setChips((x) => [...x, { kind: "file", arg: activePath }])} data-testid="attach-active">
              + {activePath.split(/[\\/]/).pop()}
            </button>
          )}
          <select aria-label="Attach" data-testid="attach-kind" className="rounded bg-[var(--hover)] px-1 text-xs" value={attachKind} onChange={(e) => {
            const k = e.target.value as Attachment["kind"] | "";
            if (k === "diff" || k === "terminal") { setChips((x) => (x.some((c) => c.kind === k) ? x : [...x, { kind: k, arg: "" }])); setAttachKind(""); } else setAttachKind(k);
          }}>
            <option value="">+ Attach…</option>
            <option value="diff">Git diff</option>
            <option value="terminal">Terminal output</option>
            <option value="folder">Folder</option>
            <option value="symbol">Symbol</option>
            <option value="docs">Docs (@docs)</option>
            <option value="web">Web page</option>
            <option value="rule">Rule (manual)</option>
            <option value="memory">Memory</option>
          </select>
          {attachKind && (
            <>
              <input aria-label="Attachment argument" data-testid="attach-arg" className="w-28 rounded bg-[var(--hover)] px-1 text-xs" placeholder={attachKind === "web" ? "https://…" : "name or path"} value={attachArg} onChange={(e) => setAttachArg(e.target.value)} />
              <button className="text-xs underline" data-testid="attach-add" onClick={() => { if (attachArg.trim()) setChips((x) => [...x, { kind: attachKind, arg: attachArg.trim() } as Attachment]); setAttachKind(""); setAttachArg(""); }}>Add</button>
            </>
          )}
        </div>
        {matchPrompts(input, prompts).length > 0 && (
          <ul className="mb-1 max-h-32 overflow-auto rounded border border-[var(--border)] bg-[var(--panel)] text-xs" data-testid="prompt-suggestions" aria-label="Saved prompts">
            {matchPrompts(input, prompts).map((p) => (
              <li key={p.name}>
                <button className="flex w-full gap-2 px-2 py-1 text-left hover:bg-[var(--hover)]" data-testid={`prompt-${p.name}`} onClick={() => setInput(`/${p.name} `)}>
                  <span className="font-mono">/{p.name}</span>
                  <span className="truncate text-[var(--muted)]">{p.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          data-testid="agent-input"
          onFocus={() => settings.runtimeProcess && prewarmRuntime()}
          rows={3}
          disabled={!root || !services}
          placeholder={root ? "Ask about the code (Enter to send, Shift+Tab cycles mode)" : "Open a folder first"}
          className="w-full resize-none rounded bg-[var(--hover)] p-2 text-sm outline-none"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            const options = matchPrompts(input, prompts);
            if (e.key === "Tab" && !e.shiftKey && options.length > 0) {
              e.preventDefault();
              setInput(`/${options[0]!.name} `);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]!);
            }
          }}
        />
        <div className="mt-1 flex items-center gap-3 text-xs text-[var(--muted)]">
          <span data-testid="token-meter" title={breakdown}>{meter ? `${meter.total.toLocaleString()} tokens${meter.calibrated ? "" : " (est.)"}` : "0 tokens"}</span>
          <span data-testid="cost">${cost.toFixed(4)}</span>
          {runtimeKind && <span data-testid="runtime-kind" title="Where the agent loop runs">agent: {runtimeKind}</span>}
          {services && (
            <span className="ml-auto flex items-center gap-1">
          <button className="rounded px-1.5 py-0.5 hover:bg-[var(--hover)]" data-testid="run-checks" onClick={() => void services.runVerification("full").catch((e) => setItems((i) => [...i, { kind: "notice", text: `Checks failed to run: ${e}` }]))}>Run checks</button>
          <button className="rounded px-1.5 py-0.5 hover:bg-[var(--hover)]" data-testid="detect-commands" onClick={() => void services.proposeCommandsSection().then((r) => setItems((i) => [...i, { kind: "notice", text: r === "proposed" ? "Proposed a ## Commands section in AGENTS.md for review." : r === "exists" ? "AGENTS.md already has a ## Commands section." : "No project commands detected." }]))}>Detect commands</button>
            </span>
          )}
          {busy && <button className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]" onClick={() => abort.current?.abort()}>Stop</button>}
        </div>
      </footer>
    </aside>
  );
}
