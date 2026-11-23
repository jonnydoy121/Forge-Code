import { useEffect, useState } from "react";
import { CLAUDE_AGENT } from "../lib/claudePlan";
import { latestOnly } from "../lib/latestOnly";
import { RuleEngine, matchSkills, type AgentDef, type AppliedRule, type DocSet, type LintWarning, type Memory, type Skill } from "@forge/context-store";
import { loadSettings, saveSettings } from "../lib/settings";
import type { WorkspaceServices } from "../lib/workspace";

interface Props {
  services: WorkspaceServices;
  version: number;
  /** workspace-relative path of the file being edited, for "why does this rule apply here" */
  activeFile: string | null;
  onOpenFile: (relPath: string) => void;
  onClose: () => void;
}

type Tab = "rules" | "memory" | "skills" | "agents" | "docs" | "connections";

export function ContextPane({ services, version, activeFile, onOpenFile, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("rules");
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="context-pane" aria-label="Context">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm">
        <strong>Context</strong>
        <div className="flex gap-3" role="tablist" aria-label="Context sections">
          {(["rules", "memory", "skills", "agents", "docs", "connections"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} data-testid={`ctx-tab-${t}`} className={tab === t ? "underline" : "text-[var(--muted)]"} onClick={() => setTab(t)}>
              {t === "rules" ? "Rules" : t === "memory" ? "Memories" : t === "skills" ? "Skills" : t === "agents" ? "Agents" : t === "docs" ? "Docs" : "Connections"}
            </button>
          ))}
        </div>
        <button className="ml-auto underline" onClick={onClose}>Close</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
        {tab === "rules" && <RulesTab services={services} version={version} activeFile={activeFile} onOpenFile={onOpenFile} />}
        {tab === "memory" && <MemoryTab services={services} version={version} />}
        {tab === "skills" && <SkillsTab services={services} version={version} onOpenFile={onOpenFile} />}
        {tab === "agents" && <AgentsTab services={services} version={version} />}
        {tab === "docs" && <DocsTab services={services} version={version} />}
        {tab === "connections" && <ConnectionsTab services={services} />}
      </div>
    </div>
  );
}

function RulesTab({ services, version, activeFile, onOpenFile }: Omit<Props, "onClose">) {
  const [applied, setApplied] = useState<AppliedRule[]>([]);
  const [warnings, setWarnings] = useState<LintWarning[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    // Loads can finish out of order; only the latest one may fill the list (an older, slower one must not overwrite it).
    const rules = latestOnly(setApplied);
    const lint = latestOnly(setWarnings);
    services.rules.invalidate();
    rules.run(services.rules.applicable(activeFile ? [activeFile] : []));
    lint.runOr(services.lintAll(), () => setWarnings([]));
    return () => {
      rules.cancel();
      lint.cancel();
    };
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

function AgentsTab({ services, version }: { services: WorkspaceServices; version: number }) {
  const [list, setList] = useState<AgentDef[] | null>(null);
  useEffect(() => {
    const load = latestOnly(setList);
    load.runOr(services.agents(), () => setList([]));
    return load.cancel;
  }, [services, version]);

  return (
    <div className="space-y-3">
      <p className="text-[var(--muted)]">
        A specialist is a markdown file in <code>.forge/agents/&lt;name&gt;.md</code> in this repository or in your own <code>~/.forge/agents</code>: a <code>description:</code>, optionally <code>tools:</code> (which of the read-only tools it may use) and{" "}
        <code>tier:</code> (scout, builder or architect), then its instructions. The agent hands it a task with <code>delegate</code> and gets back only a report. Specialists read and report; they cannot edit or run commands.
      </p>
      {list === null ? null : list.length === 0 ? (
        <p data-testid="agents-empty">No specialists yet. Create <code>.forge/agents/reviewer.md</code> with a <code>description:</code> line and instructions.</p>
      ) : (
        <ul className="space-y-2" aria-label="Specialists">
          {list.map((a) => (
            <li key={`${a.source}:${a.name}`} className="rounded border border-[var(--border)] p-2" data-testid="agent-def" data-agent={a.name}>
              <div className="flex items-center gap-2">
                <strong>{a.name}</strong>
                <span className="rounded bg-[var(--hover)] px-1 text-xs">{a.source === "project" ? "this repo" : "personal"}</span>
                <span className="rounded bg-[var(--hover)] px-1 text-xs" data-testid="agent-tier">{a.tier ?? "builder"}</span>
              </div>
              <div>{a.description}</div>
              <div className="text-xs text-[var(--muted)]" data-testid="agent-tools">Tools: {a.tools ? a.tools.join(", ") : "all read-only tools"}</div>
              {a.problems.map((p) => (
                <div key={p} className="text-xs text-amber-400" data-testid="agent-problem">{p}</div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillsTab({ services, version, onOpenFile }: { services: WorkspaceServices; version: number; onOpenFile: (path: string) => void }) {
  const [list, setList] = useState<Skill[] | null>(null);
  const [off, setOff] = useState<string[]>(() => loadSettings().autoSkillsOff);
  const [trial, setTrial] = useState("");
  const setSkillAuto = (name: string, on: boolean) => {
    const next = on ? off.filter((n) => n !== name) : [...off.filter((n) => n !== name), name];
    setOff(next);
    saveSettings({ ...loadSettings(), autoSkillsOff: next });
  };
  const live = loadSettings();
  const preview = list && trial.trim() ? matchSkills(trial, list, { max: live.autoSkillsMax, sensitivity: live.autoSkillsSensitivity, exclude: off }) : [];
  useEffect(() => {
    const load = latestOnly(setList);
    load.runOr(services.skills(), () => setList([]));
    return load.cancel;
  }, [services, version]);

  return (
    <div className="space-y-3">
      <p className="text-[var(--muted)]">
        A skill is a folder with a SKILL.md, in <code>.forge/skills/&lt;name&gt;/</code> in this repository (you can commit them) or in your own <code>~/.forge/skills</code>. The agent loads one when a task calls for it. A skill can bundle scripts
        (.js .mjs .cjs .py .sh); you are asked before each one runs, and it runs in the OS sandbox when that is on. Scripts are code, so only use skills from repositories you trust.
      </p>
      {list && list.length > 0 && (
        <div className="space-y-1 rounded border border-[var(--border)] p-2">
          <label className="block">
            Try a request: which skills would be applied automatically?
            <input data-testid="skill-preview-input" className="mt-1 block w-full rounded bg-[var(--hover)] px-2 py-1" placeholder="e.g. write the commit message for this change" value={trial} onChange={(e) => setTrial(e.target.value)} />
          </label>
          {trial.trim() &&
            (preview.length === 0 ? (
              <p className="text-[var(--muted)]" data-testid="skill-preview-none">None. {live.autoSkills ? "The agent can still load a skill itself from the index." : "Automatic skills are off in Settings."}</p>
            ) : (
              <ul data-testid="skill-preview">
                {preview.map((m) => (
                  <li key={m.skill.name} data-preview-skill={m.skill.name}>
                    <strong>{m.skill.name}</strong> <span className="text-[var(--muted)]">matches: {m.matched.join(", ")}</span>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
      {list === null ? null : list.length === 0 ? (
        <p data-testid="skills-empty">No skills yet. Create <code>.forge/skills/my-skill/SKILL.md</code> with a <code>description:</code> line and instructions.</p>
      ) : (
        <ul className="space-y-2" aria-label="Skills">
          {list.map((s) => (
            <li key={`${s.source}:${s.name}`} className="rounded border border-[var(--border)] p-2" data-testid="skill" data-skill={s.name}>
              <div className="flex items-center gap-2">
                <strong>{s.name}</strong>
                <span className="rounded bg-[var(--hover)] px-1 text-xs" data-testid="skill-source">{s.source === "project" ? "this repo" : "personal"}</span>
                <label className="ml-auto flex items-center gap-1 text-xs">
                  <input type="checkbox" data-testid="skill-auto" checked={!off.includes(s.name)} onChange={(e) => setSkillAuto(s.name, e.target.checked)} />
                  Apply automatically
                </label>
                <button className="underline" onClick={() => onOpenFile(`${s.dir}/SKILL.md`)}>Open SKILL.md</button>
              </div>
              <div className="text-[var(--muted)]">{s.description}</div>
              {s.scripts.length > 0 && (
                <div className="mt-1" data-testid="skill-scripts">
                  Scripts:{" "}
                  {s.scripts.map((f) => (
                    <code key={f} className="mr-2" title={s.declared[f]?.description}>
                      {f}
                      {s.declared[f] ? " (typed)" : ""}
                    </code>
                  ))}
                </div>
              )}
              {s.problems.length > 0 && (
                <div className="mt-1 text-amber-400" role="alert" data-testid="skill-problems">
                  tools.json: {s.problems.join("; ")}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemoryTab({ services, version }: { services: WorkspaceServices; version: number }) {
  const [list, setList] = useState<Memory[]>([]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ m: Memory; body: string } | null>(null);
  const [draft, setDraft] = useState<{ name: string; body: string; scope: "project" | "user" } | null>(null);

  useEffect(() => {
    const load = latestOnly(setList); // typing "ab" starts a search for "a" and one for "ab": the older one must not win
    load.run(services.memories.search(q));
    return load.cancel;
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
    const load = latestOnly(setList);
    load.run(services.docs.list());
    return load.cancel;
  }, [services, version]);

  return (
    <div className="space-y-3">
      <p className="text-[var(--muted)]">Add library documentation by URL; Forge-Code indexes it locally so <code>@docs:name</code> retrieves current API references instead of relying on model memory. Fetching sends one request to the URL you enter.</p>
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

function ConnectionsTab({ services }: { services: WorkspaceServices }) {
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const status = services.mcp.status();
  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-1 font-semibold">MCP servers</h3>
        <p className="mb-2 text-[var(--muted)]">External tool servers (databases, browsers, issue trackers) configured in <code>.forge/mcp.json</code>. Their tools ask for approval before use, and their results are treated as untrusted data. Starting a server runs a program on your machine, so you are asked first.</p>
        {services.mcp.errors.map((e, i) => <p key={i} className="text-red-400">{e}</p>)}
        <ul className="mb-2 space-y-1" data-testid="mcp-list">
          {services.mcp.configured.map((c) => {
            const st = status.find((x) => x.name === c.name);
            return (
              <li key={c.name} className="rounded border border-[var(--border)] p-2" data-testid="mcp-server">
                <strong>{c.name}</strong> <code className="text-xs text-[var(--muted)]">{[c.command, ...c.args].join(" ")}</code>
                {st && <div className={st.state === "ready" ? "text-green-400" : "text-red-400"} data-testid="mcp-state">{st.state}{st.error ? `: ${st.error}` : ` · ${st.tools.length} tools`}</div>}
              </li>
            );
          })}
          {services.mcp.configured.length === 0 && <li className="text-[var(--muted)]">None configured.</li>}
        </ul>
        {services.mcp.configured.length > 0 && (
          <div className="flex gap-2">
            <button className="rounded bg-[var(--hover)] px-2 py-1" data-testid="mcp-connect" disabled={busy} onClick={() => { setBusy(true); services.mcp.connect().then((t) => setMsg(`Connected: ${t.length} tools available to the agent in new sessions.`)).catch((e) => setMsg(`Failed: ${e}`)).finally(() => { setBusy(false); setTick((x) => x + 1); }); }}>Connect</button>
            <button className="rounded bg-[var(--hover)] px-2 py-1" onClick={() => { services.mcp.disconnect(); setTick((x) => x + 1); }}>Disconnect</button>
          </div>
        )}
        {msg && <div role="status" data-testid="mcp-msg">{msg}</div>}
      </section>
      <section>
        <h3 className="mb-1 font-semibold">External agents (ACP)</h3>
        <p className="mb-2 text-[var(--muted)]">Agents such as Claude Code, Gemini CLI or Codex that speak the Agent Client Protocol, configured in <code>.forge/acp.json</code>. Pick one from the agent panel's mode menu: its edits come through Forge's review pane like any other change.</p>
        {services.acp.errors.map((e, i) => <p key={i} className="text-red-400">{e}</p>)}
        <ul className="space-y-1" data-testid="acp-list">
          {services.acp.agents.map((a) => (
            <li key={a.name} className="rounded border border-[var(--border)] p-2" data-testid="acp-agent">
              <strong>{a.name}</strong> <code className="text-xs text-[var(--muted)]">{[a.command, ...a.args].join(" ")}</code>
              {a === CLAUDE_AGENT && <span className="ml-1 text-xs text-[var(--muted)]" data-testid="acp-builtin">(built in: your Claude plan, shown when Claude Code is signed in)</span>}
            </li>
          ))}
          {services.acp.agents.length === 0 && <li className="text-[var(--muted)]">None configured.</li>}
        </ul>
      </section>
    </div>
  );
}
