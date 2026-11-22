import { useEffect, useRef, useState } from "react";
import type { Mode } from "@forge/protocol";
import { redactSecrets, isSecretPath } from "@forge/protocol";
import type { Runtime, MeterEntry } from "@forge/agent-runtime";
import { createSession, type AuditEntry } from "../lib/agentSession";
import { fsApi } from "../lib/ipc";
import { DEFAULT_MODELS, loadSettings, saveSettings, sendsCodeOffMachine, type AgentSettings } from "../lib/settings";

const MODES: Mode[] = ["ask", "plan", "agent", "debug"];

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; ok: boolean; output: string }
  | { kind: "notice"; text: string };

interface Props {
  root: string | null;
  activePath: string | null;
}

export function AgentPanel({ root, activePath }: Props) {
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
  const runtime = useRef<Runtime | null>(null);
  const abort = useRef<AbortController | null>(null);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [items]);
  useEffect(() => {
    runtime.current = null; // new workspace or settings: build a fresh session on next send
  }, [root, settings]);

  const update = (patch: Partial<AgentSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  async function send() {
    const prompt = input.trim();
    if (!prompt || busy || !root) return;
    setInput("");
    setBusy(true);
    setItems((i) => [...i, { kind: "user", text: prompt }, { kind: "assistant", text: "" }]);
    try {
      if (!runtime.current) {
        runtime.current = await createSession({
          root,
          settings,
          audit: (e) => setAudit((a) => [...a, e]),
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
            return out;
          },
        });
      }
      const rt = runtime.current;
      abort.current = new AbortController();
      for await (const ev of rt.run({ mode, prompt, signal: abort.current.signal })) {
        if (ev.type === "text") {
          setItems((i) => {
            const last = i[i.length - 1];
            return last?.kind === "assistant" ? [...i.slice(0, -1), { kind: "assistant", text: last.text + ev.delta }] : i;
          });
        } else if (ev.type === "tool_result") {
          setItems((i) => [...i.slice(0, -1), { kind: "tool", name: ev.name, ok: ev.result.ok, output: ev.result.output }, { kind: "assistant", text: "" }]);
        } else if (ev.type === "limit") {
          setItems((i) => [...i, { kind: "notice", text: `Stopped: ${ev.reason} limit reached.` }]);
        }
      }
      setCost(rt.costUsd);
      if (rt.lastContext) setMeter({ total: rt.lastContext.totalTokens, entries: rt.lastContext.meter });
    } catch (e) {
      setItems((i) => [...i, { kind: "notice", text: `Error: ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setItems((i) => i.filter((x) => !(x.kind === "assistant" && x.text === "")));
      setBusy(false);
    }
  }

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
        <button className="text-xs underline" onClick={() => setShowAudit((s) => !s)}>Audit</button>
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
          <label className="block">Max steps <input type="number" className="ml-2 w-16 rounded bg-[var(--hover)] px-1" value={settings.maxSteps} onChange={(e) => update({ maxSteps: Number(e.target.value) || 12 })} /> Max $ <input type="number" step="0.5" className="ml-2 w-16 rounded bg-[var(--hover)] px-1" value={settings.maxCostUsd} onChange={(e) => update({ maxCostUsd: Number(e.target.value) || 2 })} /></label>
          <p className="text-[var(--muted)]">Key is stored in this app's local storage (OS keychain arrives in Phase 8).</p>
        </div>
      )}

      {showAudit ? (
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
            it.kind === "tool" ? (
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
          disabled={!root}
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
