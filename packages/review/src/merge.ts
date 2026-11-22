import { diffHunks, joinLines, splitLines, type Hunk } from "./diff";

export interface Conflict {
  base: string[];
  ours: string[];
  theirs: string[];
}

export interface MergeResult {
  /** Merged text. Conflicting regions carry git-style markers. */
  text: string;
  lines: string[];
  conflicts: Conflict[];
  clean: boolean;
}

const overlaps = (a: Hunk, b: Hunk) => {
  const aEnd = a.oldStart + a.oldLines.length;
  const bEnd = b.oldStart + b.oldLines.length;
  return a.oldStart <= bEnd && b.oldStart <= aEnd; // touching counts, like diff3
};

/** Apply hunks that fall inside [start, end) of the base to that slice. */
function sliceWith(base: string[], hunks: Hunk[], start: number, end: number): string[] {
  const out: string[] = [];
  let i = start;
  for (const h of hunks) {
    while (i < h.oldStart) out.push(base[i++]!);
    out.push(...h.newLines);
    i = h.oldStart + h.oldLines.length;
  }
  while (i < end) out.push(base[i++]!);
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * Three-way merge of `ours` (what is on disk now, e.g. the developer's edits) and `theirs` (the agent's
 * proposal) against their common `base`. Non-overlapping changes merge cleanly; overlapping, differing
 * changes become conflicts. Never silently picks a side.
 */
export function merge3(baseText: string, oursText: string, theirsText: string, labels = { ours: "disk", theirs: "agent" }): MergeResult {
  const base = splitLines(baseText);
  const ours = diffHunks(base, splitLines(oursText));
  const theirs = diffHunks(base, splitLines(theirsText));
  const out: string[] = [];
  const conflicts: Conflict[] = [];
  let i = 0;
  let a = 0;
  let b = 0;
  while (a < ours.length || b < theirs.length) {
    const ha = ours[a];
    const hb = theirs[b];
    const first = !hb || (ha && ha.oldStart <= hb.oldStart) ? ha! : hb;
    // Grow a region of mutually overlapping hunks from both sides.
    let start = first.oldStart;
    let end = first.oldStart + first.oldLines.length;
    const ga: Hunk[] = [];
    const gb: Hunk[] = [];
    let grew = true;
    while (grew) {
      grew = false;
      while (a < ours.length && ours[a]!.oldStart <= end && ours[a]!.oldStart + ours[a]!.oldLines.length >= start && (ga.length > 0 || overlapsRegion(ours[a]!, start, end))) {
        ga.push(ours[a]!);
        end = Math.max(end, ours[a]!.oldStart + ours[a]!.oldLines.length);
        start = Math.min(start, ours[a]!.oldStart);
        a++;
        grew = true;
      }
      while (b < theirs.length && theirs[b]!.oldStart <= end && theirs[b]!.oldStart + theirs[b]!.oldLines.length >= start && (gb.length > 0 || overlapsRegion(theirs[b]!, start, end))) {
        gb.push(theirs[b]!);
        end = Math.max(end, theirs[b]!.oldStart + theirs[b]!.oldLines.length);
        start = Math.min(start, theirs[b]!.oldStart);
        b++;
        grew = true;
      }
    }
    while (i < start) out.push(base[i++]!);
    const baseSlice = base.slice(start, end);
    const o = sliceWith(base, ga, start, end);
    const t = sliceWith(base, gb, start, end);
    if (gb.length === 0 || same(o, t)) out.push(...o);
    else if (ga.length === 0 || same(o, baseSlice)) out.push(...t);
    else if (same(t, baseSlice)) out.push(...o);
    else {
      conflicts.push({ base: baseSlice, ours: o, theirs: t });
      out.push(`<<<<<<< ${labels.ours}`, ...o, "=======", ...t, `>>>>>>> ${labels.theirs}`);
    }
    i = end;
  }
  while (i < base.length) out.push(base[i++]!);
  return { text: joinLines(out), lines: out, conflicts, clean: conflicts.length === 0 };
}

const overlapsRegion = (h: Hunk, start: number, end: number) => h.oldStart <= end && h.oldStart + h.oldLines.length >= start;
void overlaps;
