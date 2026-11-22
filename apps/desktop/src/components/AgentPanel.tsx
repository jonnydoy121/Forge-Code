import { useEffect, useRef, useState } from "react";
import type { Mode } from "@forge/protocol";
import type { Message } from "@forge/protocol";
import type { Runtime, MeterEntry, ContextSection } from "@forge/agent-runtime";
import { createSession, type AuditEntry } from "../lib/agentSession";
import { fsApi, indexBackend } from "../lib/ipc";
import { attachmentKey, attachmentLabel, resolveAttachment, type Attachment } from "../lib/attachments";
import { RuleEngine, detectCorrection, renderMemories, selectMemories, suggestNewThread, stringifyFrontmatter, type Correction, type SessionRecord } from "@forge/context-store";
import { terminalRegistry } from "../lib/terminalRegistry";
import { fetchText } from "../lib/http";
import { DEFAULT_MODELS, loadSettings, saveSettings, sendsCodeOffMachine, type AgentSettings } from "../lib/settings";
import { completeOnce } from "../lib/agentSession";
import type { WorkspaceServices } from "../lib/workspace";
import { Timeline } from "./Timeline";
import { classifyIntent, looksLarge } from "@forge/plans";
import { ReportCard } from "./ReportCard";
import type { VerificationReport } from "@forge/verify";
import { git, type ReportEvent } from "../lib/workspace";

const MODES: Mode[] = ["ask", "plan", "agent", "debug"];

/** Replace the last assistant item (the streaming placeholder) with `next`, keeping any notices added since. */
function replaceLastAssistant(items: Item[], next: Item[]): Item[] {
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === "assistant") return [...items.slice(0, k), ...next, ...items.slice(k + 1)];
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
  | { kind: "tool"; name: string; ok: boolean; output: string }
  | { kind: "notice"; text: string }
  | { kind: "report"; report: VerificationReport; source: string }
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
}

export function AgentPanel({ root, activePath, services, pendingCount, version, onOpenReview, onFilesChanged, registerSend, externalReport, onReport, onHook, activePlanSlug, onStartBuild }: Props) {
  const [settings, setSettings] = useState<AgentSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [mode, setMode] = useState<Mode>("ask");
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [chips, setChips] = useState<Attachment[]>([]);
  const [attachKind, setAttachKind] = useState<Attachment["kind"] | "">("");
  const [attachArg, setAttachArg] = useState("");
  const [busy, setBusy] = useState(false);
  const [meter, setMeter] = useState<{ total: number; entries: MeterEntry[]; calibrated: boolean } | null>(null);
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [newThread, setNewThread] = useState<string | null>(null);
  const [resumable, setResumable] = useState<SessionRecord | null>(null);
  const promptsRef = useRef<string[]>([]);
  const promptRef = useRef("");
  const planRef = useRef<string | null>(null);
  const pendingHistory = useRef<Message[] | null>(null);
  const [cost, setCost] = useState(0);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [suggest, setSuggest] = useState<string | null>(null);
  const runtime = useRef<Runtime | null>(null);
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
    runtime.current = null; // new workspace or settings: build a fresh session on next send
  }, [root, settings]);

  useEffect(() => {
    setResumable(null);
    if (services) void services.sessions.latest().then((r) => setResumable(r && r.messages.length > 0 ? r : null)).catch(() => {});
  }, [services]);

  const seenReport = useRef(0);
  useEffect(() => {
    if (externalReport && externalReport.seq !== seenReport.current) {
      seenReport.current = externalReport.seq;
      setItems((i) => [...i, { kind: "report", report: externalReport.report, source: externalReport.source === "accepted-changes" ? "after you accepted changes" : "manual" }]);
    }
  }, [externalReport]);

  const update = (patch: Partial<AgentSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  async function send(override?: { prompt: string; mode?: Mode; skipSuggest?: boolean }): Promise<RunOutcome> {
    const outcome: RunOutcome = {};
    const prompt = (override?.prompt ?? input).trim();
    const runMode = override?.mode ?? mode;
    if (!prompt || busy || !root || !services) return outcome;

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
    try {
      if (!runtime.current) {
        runtime.current = await createSession({
          root,
          settings,
          services,
          audit: (e) => setAudit((a) => [...a, e]),
          onHook: (event, output) => onHook(event, output),
          sections: async () => {
            const out: ContextSection[] = [];
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
              const map = await indexBackend.repoMap(focus, 1500);
              if (map) out.push({ id: "repo-map", label: "Repo map (ranked by relevance to your open files)", priority: 3, text: map });
            } catch {
              /* index not ready yet: the agent can still use grep/read tools */
            }
            return out;
          },
        });
      }
      const rt = runtime.current;
      if (pendingHistory.current) {
        rt.history.push(...pendingHistory.current);
        pendingHistory.current = null;
      }
      abort.current = new AbortController();
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
      void services.sessions.save({ id: services.sessionId, savedAt: new Date().toISOString(), messages: rt.history, summaries: rt.summaries }).catch(() => {});
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
    registerSend(async (prompt, m) => {
      setMode(m ?? "agent");
      return sendRef.current({ prompt, mode: m ?? "agent" });
    });
  }, [registerSend]);

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
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          {MODES.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <span className={`ml-auto text-xs ${offMachine ? "text-amber-400" : "text-green-400"}`} data-testid="privacy-badge" title={offMachine ? "Prompts and attached code are sent to a remote server" : "Local model: nothing leaves this machine"}>
          {offMachine ? "remote" : "local"}
        </span>
        <button className="text-xs underline" data-testid="timeline-toggle" onClick={() => { setShowTimeline((s) => !s); setShowAudit(false); }}>Checkpoints</button>
        <button className="text-xs underline" onClick={() => { setShowAudit((s) => !s); setShowTimeline(false); }}>Audit</button>
        <button className="text-xs underline" onClick={() => setShowSettings((s) => !s)} data-testid="settings-toggle">Settings</button>
      </header>

      {showSettings && (
        <div className="space-y-1 border-b border-[var(--border)] p-3 text-xs" data-testid="settings">
          <label className="block">Provider
            <select className="ml-2 rounded bg-[var(--hover)]" value={settings.provider} onChange={(e) => update({ provider: e.target.value as AgentSettings["provider"], model: DEFAULT_MODELS[e.target.value as AgentSettings["provider"]] })}>
              <option value="ollama">Ollama (local)</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </label>
          <label className="block">Model <input className="ml-2 w-52 rounded bg-[var(--hover)] px-1" value={settings.model} onChange={(e) => update({ model: e.target.value })} /></label>
          <label className="block">Base URL <input data-testid="base-url" className="ml-2 w-52 rounded bg-[var(--hover)] px-1" placeholder="default" value={settings.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} /></label>
          <label className="block">API key <input type="password" className="ml-2 w-52 rounded bg-[var(--hover)] px-1" value={settings.apiKey} onChange={(e) => update({ apiKey: e.target.value })} /></label>
          <label className="block">Edits
            <select data-testid="review-mode" className="ml-2 rounded bg-[var(--hover)]" value={settings.reviewMode} onChange={(e) => update({ reviewMode: e.target.value as AgentSettings["reviewMode"] })}>
              <option value="review">Review every edit</option>
              <option value="plan-files">Auto-apply files in the plan</option>
              <option value="auto">Auto-apply everything (checkpointed)</option>
            </select>
          </label>
          <label className="block">Max steps <input type="number" className="ml-2 w-16 rounded bg-[var(--hover)] px-1" value={settings.maxSteps} onChange={(e) => update({ maxSteps: Number(e.target.value) || 12 })} /> Max $ <input type="number" step="0.5" className="ml-2 w-16 rounded bg-[var(--hover)] px-1" value={settings.maxCostUsd} onChange={(e) => update({ maxCostUsd: Number(e.target.value) || 2 })} /></label>
          <label className="block">Context budget <input type="number" data-testid="budget-tokens" className="ml-2 w-24 rounded bg-[var(--hover)] px-1" value={settings.budgetTokens} onChange={(e) => update({ budgetTokens: Number(e.target.value) || 100000 })} /> compact at <input type="number" step="0.05" min="0.3" max="0.95" className="w-14 rounded bg-[var(--hover)] px-1" value={settings.compactionThreshold} onChange={(e) => update({ compactionThreshold: Number(e.target.value) || 0.8 })} /></label>
          <label className="block"><input type="checkbox" data-testid="auto-memories" checked={settings.autoMemories} onChange={(e) => update({ autoMemories: e.target.checked })} /> Let the agent create memories itself (you always see them; off by default)</label>
          <label className="block">Your rules (every project, lowest precedence)
            <textarea data-testid="user-rules" className="mt-1 h-16 w-full rounded bg-[var(--hover)] p-1" value={settings.userRules} onChange={(e) => update({ userRules: e.target.value })} />
          </label>
          <p className="text-[var(--muted)]">Key is stored in this app's local storage (OS keychain arrives in Phase 8).</p>
        </div>
      )}

      {services && (
        <div className="flex gap-2 border-b border-[var(--border)] px-3 py-1 text-xs">
          <button className="underline" data-testid="run-checks" onClick={() => void services.runVerification("full").catch((e) => setItems((i) => [...i, { kind: "notice", text: `Checks failed to run: ${e}` }]))}>Run checks</button>
          <button className="underline" data-testid="detect-commands" onClick={() => void services.proposeCommandsSection().then((r) => setItems((i) => [...i, { kind: "notice", text: r === "proposed" ? "Proposed a ## Commands section in AGENTS.md for review." : r === "exists" ? "AGENTS.md already has a ## Commands section." : "No project commands detected." }]))}>Detect commands</button>
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
              if (runtime.current) runtime.current.history.length = Math.min(n, runtime.current.history.length);
              setItems((i) => [...i, { kind: "notice", text: `Conversation restored to ${n} messages.` }]);
            }}
            draftCommitMessage={async (diff) => {
              try {
                return await completeOnce(settings, `Write a concise git commit message (imperative mood, max 72 char subject, optional short body) for this change. Reply with the message only.

${diff}`);
              } catch {
                return null;
              }
            }}
          />
        </div>
      ) : showAudit ? (
        <ul className="flex-1 overflow-auto p-2 font-mono text-xs" data-testid="audit-log">
          {audit.length === 0 && <li className="text-[var(--muted)]">No activity yet.</li>}
          {audit.map((a, i) => (
            <li key={i}>{new Date(a.at).toLocaleTimeString()} {a.kind} {a.name} {a.detail}</li>
          ))}
        </ul>
      ) : (
        <div className="flex-1 space-y-2 overflow-auto p-3 text-sm" data-testid="messages">
          {items.length === 0 && <p className="text-[var(--muted)]">Ask a question about this codebase. Mode "ask" is read-only.</p>}
          {items.map((it, i) =>
            it.kind === "compaction" ? (
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
              <div key={i} data-testid={it.kind} className={it.kind === "user" ? "rounded bg-[var(--hover)] p-2" : it.kind === "notice" ? "text-amber-400" : "whitespace-pre-wrap"}>
                {it.text}
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
            <button className="rounded bg-blue-700/70 px-2 py-0.5" data-testid="newthread-yes" onClick={() => { runtime.current = null; promptsRef.current = []; setItems([]); const p = newThread; setNewThread(null); void send({ prompt: p, mode }); setInput(""); }}>New thread</button>
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
        <textarea
          data-testid="agent-input"
          rows={3}
          disabled={!root || !services}
          placeholder={root ? "Ask about the code (Enter to send, Shift+Tab cycles mode)" : "Open a folder first"}
          className="w-full resize-none rounded bg-[var(--hover)] p-2 text-sm outline-none"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
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
          {busy && <button className="ml-auto underline" onClick={() => abort.current?.abort()}>Stop</button>}
        </div>
      </footer>
    </aside>
  );
}
