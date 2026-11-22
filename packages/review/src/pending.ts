import type { CheckpointStore } from "@forge/protocol";
import { applyHunks, diffHunks, joinLines, splitLines, statsOf, type DiffStats, type Hunk } from "./diff";
import { merge3, type Conflict } from "./merge";

export type ReviewMode = "review" | "plan-files" | "auto";
export type Decision = "accepted" | "rejected";

/** Disk access. `null` = file does not exist. Paths are absolute, forward-slash. */
export interface DiskFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface PendingDeps {
  fs: DiskFs;
  checkpoints: Pick<CheckpointStore, "snapshot">;
  mode(): ReviewMode;
  /** Absolute paths allowed by the approved plan (used by "plan-files" mode). */
  planFiles?(): string[] | null;
  /** Length of the agent conversation, recorded in each checkpoint so the timeline can restore it. */
  historyLength?(): number;
  onChange?(): void;
}

export interface PendingFile {
  path: string;
  /** Disk content when the first proposal arrived. null = file did not exist. */
  base: string | null;
  /** Proposed content. null = the agent wants to delete the file. */
  proposed: string | null;
  changeSet: string;
  step?: number;
  hunks: Hunk[];
  /** One-line reason per hunk (from the edit call that introduced it). */
  reasons: Record<string, string>;
  resolved: Record<string, Decision>;
  stats: DiffStats;
  /** Set when the file changed on disk after the proposal and could not be merged automatically. */
  conflict?: { merged: string; conflicts: Conflict[] };
}

export type ProposeStatus = "pending" | "applied" | "conflict" | "noop";
export interface ProposeResult { status: ProposeStatus; stats: DiffStats; checkpoint?: string }

export interface ChangeSetInfo { id: string; label: string; step?: number; files: string[] }

const textOf = (t: string | null) => t ?? "";

/** Agent edits layered over the real files. Nothing reaches disk until accepted (or auto-applied, always with a checkpoint). */
export class PendingChanges {
  private files = new Map<string, PendingFile>();
  private sets = new Map<string, ChangeSetInfo>();
  private currentSet = "";
  private seq = 0;

  constructor(private deps: PendingDeps) {
    this.beginChangeSet("changes");
  }

  beginChangeSet(label: string, step?: number): string {
    const id = `cs-${++this.seq}`;
    this.sets.set(id, { id, label, step, files: [] });
    this.currentSet = id;
    return id;
  }

  setStep(step: number | undefined) {
    const s = this.sets.get(this.currentSet);
    if (s) s.step = step;
  }

  get currentChangeSet() {
    return this.currentSet;
  }

  /** What the agent should see when it reads `path`: the proposed content if one is pending, else undefined (read disk). */
  effective(path: string): string | null | undefined {
    const f = this.files.get(path);
    return f ? f.proposed : undefined;
  }

  get(path: string): PendingFile | undefined {
    return this.files.get(path);
  }

  list(): PendingFile[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  changeSets(): (ChangeSetInfo & { pending: PendingFile[] })[] {
    return [...this.sets.values()].map((s) => ({ ...s, pending: this.list().filter((f) => f.changeSet === s.id) })).filter((s) => s.pending.length > 0);
  }

  private notify() {
    this.deps.onChange?.();
  }

  async propose(path: string, proposed: string | null, reason = ""): Promise<ProposeResult> {
    const existing = this.files.get(path);
    const base = existing ? existing.base : await this.deps.fs.read(path);
    const oldHunkIds = new Set(existing?.hunks.map((h) => h.id));
    if (proposed === base) {
      this.files.delete(path);
      this.notify();
      return { status: "noop", stats: { added: 0, removed: 0 } };
    }
    const hunks = diffHunks(splitLines(textOf(base)), splitLines(textOf(proposed)));
    const reasons: Record<string, string> = {};
    const resolved: Record<string, Decision> = {};
    for (const h of hunks) {
      reasons[h.id] = oldHunkIds.has(h.id) ? existing!.reasons[h.id] ?? reason : reason;
      if (existing?.resolved[h.id]) resolved[h.id] = existing.resolved[h.id]!;
    }
    const file: PendingFile = {
      path,
      base,
      proposed,
      changeSet: existing?.changeSet ?? this.currentSet,
      step: existing?.step ?? this.sets.get(this.currentSet)?.step,
      hunks,
      reasons,
      resolved,
      stats: statsOf(hunks),
    };
    this.files.set(path, file);
    const set = this.sets.get(file.changeSet);
    if (set && !set.files.includes(path)) set.files.push(path);
    this.notify();

    const mode = this.deps.mode();
    const inPlan = this.deps.planFiles?.()?.includes(path) ?? false;
    if (mode === "auto" || (mode === "plan-files" && inPlan)) {
      const r = await this.resolveAll(path, "accepted");
      const status: ProposeStatus = r.status === "applied" ? "applied" : r.status === "conflict" ? "conflict" : "noop";
      return { status, stats: file.stats, checkpoint: "checkpoint" in r ? r.checkpoint : undefined };
    }
    return { status: "pending", stats: file.stats };
  }

  /** Accept or reject one hunk. When every hunk of the file is decided, the file is finalised. */
  async resolveHunk(path: string, hunkId: string, decision: Decision): Promise<{ status: "open" | "applied" | "discarded" | "conflict"; checkpoint?: string }> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no pending change for ${path}`);
    if (!f.hunks.some((h) => h.id === hunkId)) throw new Error(`unknown hunk ${hunkId}`);
    f.resolved[hunkId] = decision;
    this.notify();
    if (f.hunks.every((h) => f.resolved[h.id])) return this.finalize(f);
    return { status: "open" };
  }

  async resolveAll(path: string, decision: Decision) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no pending change for ${path}`);
    for (const h of f.hunks) f.resolved[h.id] = decision;
    return this.finalize(f);
  }

  /** Accept or reject everything (optionally restricted to one change set). */
  async resolveEverything(decision: Decision, changeSet?: string) {
    const out: Record<string, string> = {};
    for (const f of this.list()) {
      if (changeSet && f.changeSet !== changeSet) continue;
      out[f.path] = (await this.resolveAll(f.path, decision)).status;
    }
    return out;
  }

  /** Replace what an accepted hunk would write (the "Edit" action). The hunk stays pending. */
  editHunk(path: string, hunkId: string, newLines: string[]) {
    const f = this.files.get(path);
    const h = f?.hunks.find((x) => x.id === hunkId);
    if (!f || !h) throw new Error(`unknown hunk ${hunkId}`);
    const edited = f.hunks.map((x) => (x.id === hunkId ? { ...x, newLines } : x));
    const proposed = joinLines(applyHunks(splitLines(textOf(f.base)), edited, () => true));
    const hunks = diffHunks(splitLines(textOf(f.base)), splitLines(proposed));
    const reason = f.reasons[hunkId] ?? "";
    f.proposed = f.proposed === null && proposed === "" ? null : proposed;
    f.reasons = Object.fromEntries(hunks.map((x) => [x.id, f.reasons[x.id] ?? reason]));
    f.resolved = Object.fromEntries(Object.entries(f.resolved).filter(([id]) => hunks.some((x) => x.id === id)));
    f.hunks = hunks;
    f.stats = statsOf(hunks);
    this.notify();
  }

  /** Result text for the hunks decided so far (rejected and undecided hunks keep their old lines). */
  private resultOf(f: PendingFile): string | null {
    const accepted = f.hunks.filter((h) => f.resolved[h.id] === "accepted");
    if (accepted.length === 0) return f.base;
    if (accepted.length === f.hunks.length && f.proposed === null) return null;
    return joinLines(applyHunks(splitLines(textOf(f.base)), f.hunks, (h) => f.resolved[h.id] === "accepted"));
  }

  private async finalize(f: PendingFile) {
    const result = this.resultOf(f);
    if (result === f.base) {
      this.files.delete(f.path);
      this.notify();
      return { status: "discarded" as const };
    }
    const current = await this.deps.fs.read(f.path);
    let toWrite: string | null = result;
    if (current !== f.base) {
      // The developer changed the file while the agent's edit was pending: never overwrite silently.
      const merged = merge3(textOf(f.base), textOf(current), textOf(result));
      if (!merged.clean || result === null) {
        f.conflict = { merged: merged.text, conflicts: merged.conflicts };
        this.notify();
        return { status: "conflict" as const };
      }
      toWrite = merged.text;
    }
    const checkpoint = await this.writeWithCheckpoint(f, toWrite);
    return { status: "applied" as const, checkpoint };
  }

  /** The developer's resolution of a conflict (the three-way merge UI supplies the final text). */
  async resolveConflict(path: string, finalText: string | null) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no pending change for ${path}`);
    const checkpoint = await this.writeWithCheckpoint(f, finalText);
    return { status: "applied" as const, checkpoint };
  }

  /** Re-run the check for a conflicted file against the current disk content (e.g. after the developer saved). */
  async retry(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no pending change for ${path}`);
    f.conflict = undefined;
    return this.finalize(f);
  }

  private async writeWithCheckpoint(f: PendingFile, content: string | null): Promise<string> {
    const cp = await this.deps.checkpoints.snapshot([f.path], {
      step: f.step,
      changeSet: f.changeSet,
      label: f.reasons[f.hunks[0]?.id ?? ""] || undefined,
      historyLength: this.deps.historyLength?.(),
    });
    if (content === null) await this.deps.fs.remove(f.path);
    else await this.deps.fs.write(f.path, content);
    this.files.delete(f.path);
    this.notify();
    return cp.id;
  }
}

/** Prompt for "comment to revise": ask the agent to change only the commented hunk. */
export function revisePrompt(path: string, hunk: Hunk, comment: string): string {
  const fmt = (ls: string[], p: string) => ls.map((l) => `${p} ${l}`).join("\n");
  return [
    `Revise ONLY one hunk of your pending change to ${path} (old lines start at line ${hunk.oldStart + 1}). Do not touch any other hunk or file.`,
    "Current hunk:",
    [fmt(hunk.oldLines, "-"), fmt(hunk.newLines, "+")].filter(Boolean).join("\n"),
    `Reviewer comment: ${comment}`,
    "Apply the fix with a single edit_file call.",
  ].join("\n");
}
