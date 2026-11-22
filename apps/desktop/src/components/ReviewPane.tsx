import { useEffect, useMemo, useRef, useState } from "react";
import type { VerificationReport } from "@forge/verify";
import { revisePrompt, splitLines, withContext, wordDiff, type Hunk, type PendingChanges, type PendingFile } from "@forge/review";

interface Props {
  pending: PendingChanges;
  root: string;
  /** bumps whenever pending changes change, to re-render */
  version: number;
  onResolved: () => void;
  onRevise: (prompt: string) => void;
  onClose: () => void;
  /** latest verification report, for per-file badges */
  report: VerificationReport | null;
}

const BADGE_KINDS: [string, string][] = [["lint", "lint"], ["typecheck", "types"], ["diagnostics", "editor"], ["test", "tests"]];

/** Per-file verification badges: green when the check passed, red when it reported problems in this file. */
function Badges({ report, file }: { report: VerificationReport | null; file: string }) {
  if (!report) return null;
  return (
    <span className="flex gap-1" data-testid="badges">
      {BADGE_KINDS.map(([kind, label]) => {
        const c = report.checks.find((x) => x.kind === kind && !x.skipped);
        if (!c) return null;
        const hit = c.errors.some((e) => e.file && (file.endsWith(e.file) || e.file.endsWith(file)));
        const bad = !c.ok && (hit || c.errors.every((e) => !e.file));
        return (
          <span key={kind} className={`rounded px-1 text-[10px] ${bad ? "bg-red-700/60" : c.ok ? "bg-green-700/50" : "bg-[var(--hover)]"}`} title={`${label}: ${bad ? "problems in this file" : c.ok ? "passed" : "failed elsewhere"}`}>
            {label} {bad ? "✗" : c.ok ? "✓" : "·"}
          </span>
        );
      })}
    </span>
  );
}

const rel = (root: string, p: string) => p.slice(root.length + 1);

function Words({ segs, cls }: { segs: { text: string; changed: boolean }[]; cls: string }) {
  return (
    <span className={cls}>
      {segs.map((s, i) => (s.changed ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </span>
  );
}

function HunkView({ file, hunk, base, mode, selected, onSelect, onDecide, onEdit, onComment }: {
  file: PendingFile;
  hunk: Hunk;
  base: string[];
  mode: "inline" | "side";
  selected: boolean;
  onSelect: () => void;
  onDecide: (d: "accepted" | "rejected") => void;
  onEdit: (lines: string[]) => void;
  onComment: (text: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<string | null>(null);
  const [explain, setExplain] = useState(false);
  const ctx = withContext(base, hunk, 2);
  const pairs = Math.min(hunk.oldLines.length, hunk.newLines.length);
  const words = Array.from({ length: pairs }, (_, i) => wordDiff(hunk.oldLines[i]!, hunk.newLines[i]!));
  const decided = file.resolved[hunk.id];

  const oldRow = (l: string, i: number) => (i < pairs ? <Words segs={words[i]!.old} cls="" /> : <span>{l}</span>);
  const newRow = (l: string, i: number) => (i < pairs ? <Words segs={words[i]!.new} cls="" /> : <span>{l}</span>);

  return (
    <div className={`mb-3 rounded border ${selected ? "border-blue-400" : "border-[var(--border)]"}`} data-testid="hunk" data-hunk-id={hunk.id} onClick={onSelect}>
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1 text-xs">
        <span className="text-[var(--muted)]">line {hunk.oldStart + 1}</span>
        {decided && <span className={decided === "accepted" ? "text-green-400" : "text-red-400"}>{decided}</span>}
        <span className="ml-auto flex gap-1">
          <button className="rounded bg-green-700/60 px-2" data-testid="accept-hunk" onClick={() => onDecide("accepted")}>Accept</button>
          <button className="rounded bg-red-700/60 px-2" data-testid="reject-hunk" onClick={() => onDecide("rejected")}>Reject</button>
          <button className="rounded bg-[var(--hover)] px-2" onClick={() => setEditing(hunk.newLines.join("\n"))}>Edit</button>
          <button className="rounded bg-[var(--hover)] px-2" onClick={() => setExplain((x) => !x)}>Explain</button>
          <button className="rounded bg-[var(--hover)] px-2" onClick={() => setCommenting("")}>Comment</button>
        </span>
      </div>
      {explain && (
        <div className="border-b border-[var(--border)] px-2 py-1 text-xs" data-testid="explain">
          {file.step !== undefined ? `Plan step ${file.step}. ` : ""}
          {file.reasons[hunk.id] || "No reason given by the agent."}
        </div>
      )}
      {mode === "inline" ? (
        <pre className="overflow-auto px-2 py-1 font-mono text-xs leading-5">
          {ctx.before.map((l, i) => <div key={`b${i}`} className="text-[var(--muted)]">{"  "}{l}</div>)}
          {hunk.oldLines.map((l, i) => <div key={`o${i}`} className="diff-del">{"- "}{oldRow(l, i)}</div>)}
          {hunk.newLines.map((l, i) => <div key={`n${i}`} className="diff-add">{"+ "}{newRow(l, i)}</div>)}
          {ctx.after.map((l, i) => <div key={`a${i}`} className="text-[var(--muted)]">{"  "}{l}</div>)}
        </pre>
      ) : (
        <div className="grid grid-cols-2 gap-px overflow-auto font-mono text-xs leading-5">
          <pre className="px-2 py-1">{hunk.oldLines.map((l, i) => <div key={i} className="diff-del">{oldRow(l, i)}</div>)}</pre>
          <pre className="px-2 py-1">{hunk.newLines.map((l, i) => <div key={i} className="diff-add">{newRow(l, i)}</div>)}</pre>
        </div>
      )}
      {editing !== null && (
        <div className="border-t border-[var(--border)] p-2">
          <textarea aria-label="Edit hunk" className="h-24 w-full rounded bg-[var(--hover)] p-1 font-mono text-xs" value={editing} onChange={(e) => setEditing(e.target.value)} />
          <button className="mr-2 rounded bg-[var(--hover)] px-2 text-xs" onClick={() => { onEdit(editing === "" ? [] : editing.split("\n")); setEditing(null); }}>Save edit</button>
          <button className="text-xs underline" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      )}
      {commenting !== null && (
        <div className="border-t border-[var(--border)] p-2">
          <textarea aria-label="Comment on hunk" className="h-16 w-full rounded bg-[var(--hover)] p-1 text-xs" placeholder="e.g. use the existing logger here" value={commenting} onChange={(e) => setCommenting(e.target.value)} />
          <button className="mr-2 rounded bg-[var(--hover)] px-2 text-xs" disabled={!commenting.trim()} onClick={() => { onComment(commenting.trim()); setCommenting(null); }}>Send to agent</button>
          <button className="text-xs underline" onClick={() => setCommenting(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function ConflictView({ file, onResolve }: { file: PendingFile; onResolve: (text: string | null) => void }) {
  const [text, setText] = useState(file.conflict!.merged);
  return (
    <div className="space-y-2 p-3 text-xs" data-testid="conflict">
      <p className="text-amber-400">You changed this file after the agent proposed its edit. Forge-Code did not overwrite your changes. Resolve the conflict below.</p>
      {file.conflict!.conflicts.map((c, i) => (
        <div key={i} className="grid grid-cols-3 gap-2">
          {[["Base", c.base], ["Yours (disk)", c.ours], ["Agent", c.theirs]].map(([label, lines]) => (
            <div key={label as string}>
              <div className="text-[var(--muted)]">{label as string}</div>
              <pre className="rounded bg-[var(--hover)] p-1">{(lines as string[]).join("\n") || "(empty)"}</pre>
            </div>
          ))}
        </div>
      ))}
      <div className="text-[var(--muted)]">Merged result (edit freely; conflict markers must be removed)</div>
      <textarea aria-label="Merged result" className="h-40 w-full rounded bg-[var(--hover)] p-1 font-mono" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="mr-2 rounded bg-green-700/60 px-2 py-1" disabled={/^(<<<<<<<|=======|>>>>>>>)/m.test(text)} onClick={() => onResolve(text)} data-testid="save-resolution">Save resolution</button>
      <button className="rounded bg-[var(--hover)] px-2 py-1" onClick={() => onResolve(file.base)}>Keep original</button>
    </div>
  );
}

export function ReviewPane({ pending, root, version, onResolved, onRevise, onClose, report }: Props) {
  const files = useMemo(() => pending.list(), [pending, version]);
  const sets = useMemo(() => pending.changeSets(), [pending, version]);
  const [sel, setSel] = useState<string | null>(null);
  const [hunkIdx, setHunkIdx] = useState(0);
  const [mode, setMode] = useState<"inline" | "side">("inline");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const file = files.find((f) => f.path === sel) ?? files[0];
  useEffect(() => {
    if (file && sel !== file.path) setSel(file.path);
  }, [file, sel]);
  const base = useMemo(() => (file ? splitLines(file.base ?? "") : []), [file]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const decide = (f: PendingFile, h: Hunk, d: "accepted" | "rejected") => run(() => pending.resolveHunk(f.path, h.id, d));

  const onKey = (e: React.KeyboardEvent) => {
    if (!file || (e.target as HTMLElement).tagName === "TEXTAREA") return;
    const h = file.hunks[hunkIdx];
    if (e.key === "j") setHunkIdx((i) => Math.min(i + 1, file.hunks.length - 1));
    else if (e.key === "k") setHunkIdx((i) => Math.max(i - 1, 0));
    else if (e.key === "a" && h) void decide(file, h, "accepted");
    else if (e.key === "r" && h) void decide(file, h, "rejected");
    else if (e.key === "A") void run(() => pending.resolveAll(file.path, "accepted"));
    else if (e.key === "R") void run(() => pending.resolveAll(file.path, "rejected"));
    else if (e.key === "n" || e.key === "]") setSel(files[(files.indexOf(file) + 1) % files.length]!.path);
    else if (e.key === "p" || e.key === "[") setSel(files[(files.indexOf(file) - 1 + files.length) % files.length]!.path);
  };

  return (
    <div ref={box} className="flex h-full min-h-0 flex-col outline-none" tabIndex={0} onKeyDown={onKey} data-testid="review-pane" aria-label="Review changes">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm">
        <strong>Review</strong>
        <span className="text-[var(--muted)]">{files.length} file{files.length === 1 ? "" : "s"}</span>
        <button className="ml-3 rounded bg-green-700/60 px-2" data-testid="accept-all" onClick={() => void run(() => pending.resolveEverything("accepted"))}>Accept all</button>
        <button className="rounded bg-red-700/60 px-2" data-testid="reject-all" onClick={() => void run(() => pending.resolveEverything("rejected"))}>Reject all</button>
        <button className="ml-3 rounded bg-[var(--hover)] px-2" onClick={() => setMode((m) => (m === "inline" ? "side" : "inline"))}>{mode === "inline" ? "Side by side" : "Inline"}</button>
        <span className="ml-auto text-xs text-[var(--muted)]">j/k hunk, a accept, r reject, A/R whole file, n/p next/prev file</span>
        <button className="underline" onClick={onClose}>Close</button>
      </div>
      {error && <div className="bg-red-900/40 px-3 py-1 text-sm" role="alert">{error}</div>}
      {files.length === 0 ? (
        <div className="p-4 text-sm text-[var(--muted)]" data-testid="review-empty">No pending changes.</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav className="w-64 shrink-0 overflow-auto border-r border-[var(--border)] text-sm" aria-label="Changed files">
            {sets.map((s) => (
              <div key={s.id}>
                <div className="flex items-center gap-1 bg-[var(--panel)] px-2 py-1 text-xs font-semibold" data-testid="change-set">
                  <span className="truncate">{s.step !== undefined ? `Step ${s.step}: ` : ""}{s.label}</span>
                  <button className="ml-auto font-normal underline" onClick={() => void run(() => pending.resolveEverything("accepted", s.id))}>accept</button>
                  <button className="font-normal underline" onClick={() => void run(() => pending.resolveEverything("rejected", s.id))}>reject</button>
                </div>
                {s.pending.map((f) => (
                  <button key={f.path} data-testid="review-file" className={`flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-[var(--hover)] ${f.path === file?.path ? "bg-[var(--hover)]" : ""}`} onClick={() => { setSel(f.path); setHunkIdx(0); }}>
                    <span className="truncate">{rel(root, f.path)}</span>
                    {f.conflict && <span className="text-amber-400" title="conflict">!</span>}
                    {f.warnings.length > 0 && <span className="text-red-400" title={f.warnings.join("; ")}>⚠</span>}
                    <span className="ml-auto whitespace-nowrap text-xs"><span className="text-green-400">+{f.stats.added}</span> <span className="text-red-400">-{f.stats.removed}</span></span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-auto">
            {file && (
              <>
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-1 text-sm">
                  <span className="truncate font-medium">{rel(root, file.path)}</span>
                  {file.base === null && <span className="text-xs text-green-400">new file</span>}
                  {file.proposed === null && <span className="text-xs text-red-400">deleted</span>}
                  <span className="ml-auto flex gap-1">
                    <button className="rounded bg-green-700/60 px-2 text-xs" data-testid="accept-file" onClick={() => void run(() => pending.resolveAll(file.path, "accepted"))}>Accept file</button>
                    <button className="rounded bg-red-700/60 px-2 text-xs" data-testid="reject-file" onClick={() => void run(() => pending.resolveAll(file.path, "rejected"))}>Reject file</button>
                  </span>
                </div>
                {file.warnings.length > 0 && (
                  <div className="border-b border-red-700 bg-red-900/40 px-3 py-1 text-xs" role="alert" data-testid="file-warning">
                    Needs your explicit approval: this change {file.warnings.join("; ")}. Auto-apply is disabled for it.
                  </div>
                )}
                <div className="flex gap-2 px-3 pt-1 text-xs text-[var(--muted)]">Checks: <Badges report={report} file={rel(root, file.path)} /></div>
                {file.conflict ? (
                  <ConflictView file={file} onResolve={(t) => void run(() => pending.resolveConflict(file.path, t))} />
                ) : (
                  <div className="p-3">
                    {file.hunks.map((h, i) => (
                      <HunkView
                        key={h.id}
                        file={file}
                        hunk={h}
                        base={base}
                        mode={mode}
                        selected={i === hunkIdx}
                        onSelect={() => setHunkIdx(i)}
                        onDecide={(d) => void decide(file, h, d)}
                        onEdit={(lines) => void run(async () => pending.editHunk(file.path, h.id, lines))}
                        onComment={(text) => onRevise(revisePrompt(rel(root, file.path), h, text))}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
