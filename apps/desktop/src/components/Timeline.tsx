import { useEffect, useState } from "react";
import type { Checkpoint } from "@forge/protocol";
import type { Hunk } from "@forge/review";
import { git, type WorkspaceServices } from "../lib/workspace";

interface Props {
  services: WorkspaceServices;
  version: number;
  /** Restore conversation to this many history entries. */
  onRestoreConversation: (historyLength: number) => void;
  onFilesChanged: () => void;
  /** Ask the model for a commit message from the diff (null = not available). */
  draftCommitMessage: (diff: string) => Promise<string | null>;
}

export function Timeline({ services, version, onRestoreConversation, onFilesChanged, draftCommitMessage }: Props) {
  const [cps, setCps] = useState<Checkpoint[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [hunks, setHunks] = useState<{ cp: string; file: string; hunks: Hunk[] } | null>(null);
  const [commit, setCommit] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    void services.checkpoints.list().then((l) => setCps([...l].reverse()));
  }, [services, version]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMsg(label);
      onFilesChanged();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const rel = (p: string) => p.slice(services.root.length + 1);
  const steps = [...new Set(cps.map((c) => c.step).filter((s): s is number => s !== undefined))].sort();

  const prepareCommit = async () => {
    const diff = (await git(services.root, ["diff"])).stdout;
    const staged = (await git(services.root, ["diff", "--cached"])).stdout;
    const status = (await git(services.root, ["status", "--porcelain"])).stdout;
    if (!status.trim()) return setMsg("Nothing to commit.");
    setCommit((await draftCommitMessage(`${status}\n${staged}\n${diff}`.slice(0, 20_000))) ?? "Update from Forge-Code agent");
  };

  return (
    <div className="space-y-2 p-3 text-xs" data-testid="timeline">
      <p className="rounded bg-amber-900/30 p-2 text-amber-300">
        Checkpoints cover file edits only. Shell commands, database changes, network calls and git pushes are not undone.
      </p>
      <div className="flex flex-wrap gap-1">
        <button className="rounded bg-[var(--hover)] px-2 py-0.5" onClick={() => void prepareCommit()} data-testid="commit-open">Commit accepted changes</button>
        <button className="rounded bg-[var(--hover)] px-2 py-0.5" onClick={() => setBranch("forge/task")} data-testid="branch-open">Create branch for this task</button>
        {steps.map((s) => (
          <button key={s} className="rounded bg-[var(--hover)] px-2 py-0.5" data-testid="rollback-step" onClick={() => void run(`Rolled back step ${s}`, () => services.checkpoints.rollback({ step: s }))}>
            Roll back step {s}
          </button>
        ))}
        {cps.length > 0 && (
          <button className="rounded bg-[var(--hover)] px-2 py-0.5" data-testid="rollback-session" onClick={() => void run("Rolled back the whole session", () => services.checkpoints.rollback({ toCheckpoint: cps[cps.length - 1]!.id }))}>
            Roll back session
          </button>
        )}
      </div>
      {commit !== null && (
        <div className="space-y-1">
          <textarea aria-label="Commit message" className="h-16 w-full rounded bg-[var(--hover)] p-1" value={commit} onChange={(e) => setCommit(e.target.value)} />
          <button className="mr-2 rounded bg-green-700/60 px-2 py-0.5" onClick={() => void run("Committed.", async () => {
            const add = await git(services.root, ["add", "-A"]);
            const c = await git(services.root, ["commit", "-m", commit]);
            if (!add.ok || !c.ok) throw new Error(c.stderr || add.stderr || "commit failed");
            setCommit(null);
          })}>Commit</button>
          <button className="underline" onClick={() => setCommit(null)}>Cancel</button>
        </div>
      )}
      {branch !== null && (
        <div className="space-y-1">
          <input aria-label="Branch name" className="w-full rounded bg-[var(--hover)] p-1" value={branch} onChange={(e) => setBranch(e.target.value)} />
          <button className="mr-2 rounded bg-green-700/60 px-2 py-0.5" onClick={() => void run(`On branch ${branch}`, async () => {
            const r = await git(services.root, ["checkout", "-b", branch]);
            if (!r.ok) throw new Error(r.stderr);
            setBranch(null);
          })}>Create</button>
          <button className="underline" onClick={() => setBranch(null)}>Cancel</button>
        </div>
      )}
      {msg && <div role="status" data-testid="timeline-msg">{msg}</div>}
      {cps.length === 0 && <div className="text-[var(--muted)]">No checkpoints yet. One is saved before every agent edit.</div>}
      <ul className="space-y-1">
        {cps.map((c) => (
          <li key={c.id} className="rounded border border-[var(--border)] p-1.5" data-testid="checkpoint">
            <div className="flex items-center gap-2">
              <span className="font-mono">{c.id}</span>
              {c.step !== undefined && <span>step {c.step}</span>}
              <span className="text-[var(--muted)]">{new Date(c.createdAt).toLocaleTimeString()}</span>
            </div>
            <div className="truncate text-[var(--muted)]" title={c.files.join("\n")}>{c.files.map(rel).join(", ")}{c.label ? ` - ${c.label}` : ""}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              <button className="rounded bg-[var(--hover)] px-1.5" data-testid="restore-code" onClick={() => void run(`Restored files from ${c.id}`, () => services.checkpoints.rollback({ toCheckpoint: c.id }))}>Restore code</button>
              <button className="rounded bg-[var(--hover)] px-1.5" data-testid="restore-chat" disabled={c.historyLength === undefined} onClick={() => { onRestoreConversation(c.historyLength!); setMsg(`Conversation restored to ${c.id}`); }}>Restore conversation</button>
              <button className="rounded bg-[var(--hover)] px-1.5" onClick={() => void run(`Restored code and conversation to ${c.id}`, async () => { await services.checkpoints.rollback({ toCheckpoint: c.id }); if (c.historyLength !== undefined) onRestoreConversation(c.historyLength); })}>Both</button>
              {c.files.map((f) => (
                <button key={f} className="rounded bg-[var(--hover)] px-1.5" onClick={() => void services.checkpoints.hunksSince(c.id, f).then((h) => setHunks({ cp: c.id, file: f, hunks: h }))}>Hunks: {rel(f)}</button>
              ))}
            </div>
            {hunks?.cp === c.id && (
              <ul className="mt-1 space-y-1" data-testid="hunk-rollback">
                {hunks.hunks.length === 0 && <li className="text-[var(--muted)]">No differences from this checkpoint.</li>}
                {hunks.hunks.map((h) => (
                  <li key={h.id} className="rounded bg-[var(--hover)] p-1">
                    <pre className="whitespace-pre-wrap font-mono">{h.oldLines.map((l) => `- ${l}`).concat(h.newLines.map((l) => `+ ${l}`)).join("\n")}</pre>
                    <button className="underline" onClick={() => void run("Rolled back one hunk", async () => { await services.checkpoints.rollbackHunk(c.id, hunks.file, h.id); setHunks(null); })}>Roll back this hunk</button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
