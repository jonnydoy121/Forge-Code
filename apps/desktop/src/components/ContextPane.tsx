import { useEffect, useState } from "react";
import { RuleEngine, type AppliedRule, type DocSet, type LintWarning, type Memory } from "@forge/context-store";
import type { WorkspaceServices } from "../lib/workspace";

interface Props {
  services: WorkspaceServices;
  version: number;
  /** workspace-relative path of the file being edited, for "why does this rule apply here" */
  activeFile: string | null;
  onOpenFile: (relPath: string) => void;
  onClose: () => void;
}

type Tab = "rules" | "memory" | "docs";

export function ContextPane({ services, version, activeFile, onOpenFile, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("rules");
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="context-pane" aria-label="Context">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm" role="tablist">
        <strong>Context</strong>
        {(["rules", "memory", "docs"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} data-testid={`ctx-tab-${t}`} className={tab === t ? "underline" : "text-[var(--muted)]"} onClick={() => setTab(t)}>
            {t === "rules" ? "Rules" : t === "memory" ? "Memories" : "Docs"}
          </button>
        ))}
        <button className="ml-auto underline" onClick={onClose}>Close</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
        {tab === "rules" && <RulesTab services={services} version={version} activeFile={activeFile} onOpenFile={onOpenFile} />}
        {tab === "memory" && <MemoryTab services={services} version={version} />}
        {tab === "docs" && <DocsTab services={services} version={version} />}
      </div>
    </div>
  );
}

function RulesTab({ services, version, activeFile, onOpenFile }: Omit<Props, "onClose">) {
  const [applied, setApplied] = useState<AppliedRule[]>([]);
  const [warnings, setWarnings] = useState<LintWarning[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    services.rules.invalidate();
    void services.rules.applicable(activeFile ? [activeFile] : []).then(setApplied);
    void services.lintAll().then(setWarnings).catch(() => setWarnings([]));
  }, [services, version, activeFile]);

  return (
    <div className="space-y-3">
      <p className="text-[var(--muted)]" data-testid="rules-for">
        {activeFile ? <>Active rules for <code>{activeFile}</code>, lowest to highest precedence. Where rules conflict the later one wins, and what you ask for now overrides all of them.</> : "Open a file to see which rules apply to it. Rules that are always on are shown below."}
      </p>
      <ul className="space-y-2" data-testid="rule-list">
        {applied.map((a) => (
          <li key={a.rule.id} className="rounded border border-[var(--border)] p-2" data-testid="rule">
            <div className="flex items-center gap-2">
              <strong>{a.rule.name}</strong>
              <span className="text-xs text-[var(--muted)]">{a.rule.label}</span>
              {a.rule.kind !== "user" && <button className="ml-auto text-xs underline" onClick={() => onOpenFile(a.rule.label)}>Open</button>}
            </div>
            <div className="text-xs text-green-400" data-testid="rule-reason">Applies because: {a.reasons.join("; ")}</div>
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs text-[var(--muted)]">{a.rule.text}</pre>
          </li>
        ))}
        {applied.length === 0 && <li className="text-[var(--muted)]">No rules apply. Add an AGENTS.md or files under .forge/rules/.</li>}
      </ul>
      {warnings.length > 0 && (
        <div data-testid="rule-warnings">
          <h3 className="mb-1 font-semibold text-amber-300">Rule warnings</h3>
          <ul className="space-y-1 text-xs">
            {warnings.map((w, i) => (
              <li key={i}><strong>{w.ruleName}:</strong> {w.message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        <button className="rounded bg-[var(--hover)] px-2 py-1" data-testid="generate-rules" onClick={() => void services.proposeGeneratedRules().then(() => setMsg("Drafted AGENTS.md from this repo. Review it in the Review pane before it is written."))}>
          Generate rules from this repo
        </button>
      </div>
      {msg && <div role="status" data-testid="rules-msg">{msg}</div>}
      <div className="text-xs text-[var(--muted)]">{RuleEngine.name} reads AGENTS.md, CLAUDE.md, .cursorrules, .cursor/rules, .windsurfrules, .github/copilot-instructions.md, nested AGENTS.md and .forge/rules/*.md.</div>
    </div>
  );
}

function MemoryTab({ services, version }: { services: WorkspaceServices; version: number }) {
  const [list, setList] = useState<Memory[]>([]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ m: Memory; body: string } | null>(null);
  const [draft, setDraft] = useState<{ name: string; body: string; scope: "project" | "user" } | null>(null);

  useEffect(() => {
    void services.memories.search(q).then(setList);
  }, [services, version, q]);

  return (
    <div className="space-y-3">
      <p className="text-[var(--muted)]">Memories are plain Markdown files: project ones live in .forge/memory (you can commit them), personal ones in your user profile. Nothing is remembered without you seeing it.</p>
      <div className="flex gap-2">
        <input aria-label="Search memories" className="flex-1 rounded bg-[var(--hover)] px-2 py-1" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="rounded bg-[var(--hover)] px-2" data-testid="memory-new" onClick={() => setDraft({ name: "", body: "", scope: "project" })}>New memory</button>
      </div>
      {draft && (
        <div className="space-y-1 rounded border border-[var(--border)] p-2">
          <input aria-label="Memory name" className="w-full rounded bg-[var(--hover)] px-2 py-1" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <textarea aria-label="Memory text" className="h-20 w-full rounded bg-[var(--hover)] p-1" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <select aria-label="Scope" className="rounded bg-[var(--hover)]" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as "project" | "user" })}>
            <option value="project">Project (.forge/memory)</option>
            <option value="user">Personal (user profile)</option>
          </select>
          <button className="ml-2 rounded bg-green-700/60 px-2" disabled={!draft.name.trim() || !draft.body.trim()} onClick={() => void services.memories.save(draft).then(() => setDraft(null))}>Save</button>
          <button className="ml-2 underline" onClick={() => setDraft(null)}>Cancel</button>
        </div>
      )}
      <ul className="space-y-2" data-testid="memory-list">
        {list.map((m) => (
          <li key={m.id} className="rounded border border-[var(--border)] p-2" data-testid="memory">
            <div className="flex items-center gap-2">
              <strong>{m.name}</strong>
              <span className="rounded bg-[var(--hover)] px-1 text-xs">{m.scope}</span>
              <span className="ml-auto flex gap-2 text-xs">
                <button className="underline" onClick={() => setEditing({ m, body: m.body })}>Edit</button>
                <button className="underline" data-testid="memory-delete" onClick={() => void services.memories.remove(m)}>Delete</button>
              </span>
            </div>
            {editing?.m.id === m.id ? (
              <div className="mt-1">
                <textarea aria-label="Edit memory" className="h-20 w-full rounded bg-[var(--hover)] p-1" value={editing.body} onChange={(e) => setEditing({ m, body: e.target.value })} />
                <button className="mr-2 rounded bg-[var(--hover)] px-2 text-xs" onClick={() => void services.memories.update(m, { body: editing.body }).then(() => setEditing(null))}>Save</button>
                <button className="text-xs underline" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : (
              <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--muted)]">{m.body}</p>
            )}
          </li>
        ))}
        {list.length === 0 && <li className="text-[var(--muted)]">No memories.</li>}
      </ul>
    </div>
  );
}

function DocsTab({ services, version }: { services: WorkspaceServices; version: number }) {
  const [list, setList] = useState<DocSet[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void services.docs.list().then(setList);
  }, [services, version]);

  return (
    <div className="space-y-3">
      <p className="text-[var(--muted)]">Add library documentation by URL; Forge indexes it locally so <code>@docs:name</code> retrieves current API references instead of relying on model memory. Fetching sends one request to the URL you enter.</p>
      <div className="flex gap-2">
        <input aria-label="Docs name" className="w-32 rounded bg-[var(--hover)] px-2 py-1" placeholder="react" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Docs URL" className="flex-1 rounded bg-[var(--hover)] px-2 py-1" placeholder="https://react.dev/reference/react" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button
          className="rounded bg-[var(--hover)] px-2"
          data-testid="docs-add"
          disabled={busy || !name.trim() || !url.trim()}
          onClick={() => {
            setBusy(true);
            services.docs
              .add(name.trim(), url.trim())
              .then((s) => setMsg(`Indexed ${s.chunks.length} passages from ${s.url}`))
              .catch((e) => setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`))
              .finally(() => setBusy(false));
          }}
        >
          Fetch and index
        </button>
      </div>
      {msg && <div role="status" data-testid="docs-msg">{msg}</div>}
      <ul className="space-y-1" data-testid="docs-list">
        {list.map((d) => (
          <li key={d.name} className="flex items-center gap-2 rounded border border-[var(--border)] p-2" data-testid="doc">
            <strong>{d.name}</strong>
            <span className="truncate text-xs text-[var(--muted)]">{d.url} · {d.chunks.length} passages</span>
            <button className="ml-auto text-xs underline" onClick={() => void services.docs.remove(d.name)}>Remove</button>
          </li>
        ))}
        {list.length === 0 && <li className="text-[var(--muted)]">No docs indexed.</li>}
      </ul>
    </div>
  );
}
