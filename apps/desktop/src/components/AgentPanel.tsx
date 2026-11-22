import { useEffect, useRef, useState } from "react";
import type { Mode } from "@forge/protocol";
import { redactSecrets, isSecretPath } from "@forge/protocol";
import type { Runtime, MeterEntry } from "@forge/agent-runtime";
import { createSession, type AuditEntry } from "../lib/agentSession";
import { fsApi, indexBackend } from "../lib/ipc";
import { DEFAULT_MODELS, loadSettings, saveSettings, sendsCodeOffMachine, type AgentSettings } from "../lib/settings";
import { completeOnce } from "../lib/agentSession";
import type { WorkspaceServices } from "../lib/workspace";
import { Timeline } from "./Timeline";
import { classifyIntent, looksLarge } from "@forge/plans";
import { ReportCard } from "./ReportCard";
import type { VerificationReport } from "@forge/verify";
import type { ReportEvent } from "../lib/workspace";

const MODES: Mode[] = ["ask", "plan", "agent", "debug"];

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
  | { kind: "report"; report: VerificationReport; source: string };

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
  const [chips, setChips] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [meter, setMeter] = useState<{ total: number; entries: MeterEntry[] } | null>(null);
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
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [items]);
  useEffect(() => {
    runtime.current = null; // new workspace or settings: build a fresh session on next send
  }, [root, settings]);

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
    // Large-looking requests: suggest Plan mode first.
    if (!override && runMode !== "plan" && runMode !== "debug" && suggest !== prompt && looksLarge(prompt)) {
      setSuggest(prompt);
      return outcome;
    }
    setSuggest(null);
    if (!override) setInput("");
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
            const out = [];
            for (const p of chipsRef.current) {
              if (isSecretPath(p)) continue;
              try {
                out.push({ id: `file:${p}`, label: `Attached file ${p}`, priority: 2, text: redactSecrets(await fsApi.readFile(p)) });
              } catch {
                /* file vanished or binary: skip */
              }
            }
            try {
              const slash = (p: string) => p.split("\\").join("/");
              const rel = (p: string) => slash(p).replace(slash(root!) + "/", "");
              const focus = [...chipsRef.current, ...(activeRef.current ? [activeRef.current] : [])].map(rel);
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
      abort.current = new AbortController();
      for await (const ev of rt.run({ mode: runMode, prompt, signal: abort.current.signal })) {
        if (ev.type === "text") {
          setItems((i) => {
            const last = i[i.length - 1];
            return last?.kind === "assistant" ? [...i.slice(0, -1), { kind: "assistant", text: last.text + ev.delta }] : i;
          });
        } else if (ev.type === "tool_result") {
          setItems((i) => [...i.slice(0, -1), { kind: "tool", name: ev.name, ok: ev.result.ok, output: ev.result.output }, { kind: "assistant", text: "" }]);
        } else if (ev.type === "verify") {
          const report = ev.report as VerificationReport;
          outcome.report = report;
          setItems((i) => [...i.slice(0, -1), { kind: "report", report, source: "agent run" }, { kind: "assistant", text: "" }]);
          const seq = Date.now() + Math.random(); // already shown inline; mark it seen so the effect below does not add it twice
          seenReport.current = seq;
          onReport({ report, source: "agent", seq });
        } else if (ev.type === "hook") {
          if (ev.output) onHook(ev.event, ev.output);
        } else if (ev.type === "limit") {
          outcome.limit = ev.reason;
          setItems((i) => [...i, { kind: "notice", text: ev.reason === "verify" ? "Stopped: checks kept failing, see the report above." : `Stopped: ${ev.reason} limit reached.` }]);
        }
      }
      setCost(rt.costUsd);
      if (rt.lastContext) setMeter({ total: rt.lastContext.totalTokens, entries: rt.lastContext.meter });
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
  const breakdown = meter?.entries.map((e) => `${e.label}: ${e.tokens}${e.trimmed ? " (trimmed)" : ""}`).join("\n") ?? "";

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
            it.kind === "report" ? (
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
        <div className="mb-1 flex flex-wrap gap-1" data-testid="chips">
          {chips.map((c) => (
            <span key={c} className="flex items-center gap-1 rounded bg-[var(--hover)] px-2 py-0.5 text-xs">
              {c.split(/[\\/]/).pop()}
              <button aria-label={`Remove ${c}`} onClick={() => setChips((x) => x.filter((y) => y !== c))}>×</button>
            </span>
          ))}
          {activePath && !chips.includes(activePath) && (
            <button className="rounded border border-dashed border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]" onClick={() => setChips((x) => [...x, activePath])} data-testid="attach-active">
              + {activePath.split(/[\\/]/).pop()}
            </button>
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
          <span data-testid="token-meter" title={breakdown}>{meter ? `${meter.total.toLocaleString()} tokens` : "0 tokens"}</span>
          <span data-testid="cost">${cost.toFixed(4)}</span>
          {busy && <button className="ml-auto underline" onClick={() => abort.current?.abort()}>Stop</button>}
        </div>
      </footer>
    </aside>
  );
}
