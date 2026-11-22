// Line and word diffing. Lossless: lines keep any trailing "\r", and join("\n") restores the exact text.

export const splitLines = (text: string): string[] => text.split("\n");
export const joinLines = (lines: string[]): string => lines.join("\n");

type Edit = { t: "=" | "-" | "+"; a: number; b: number };

/** Myers O(ND) shortest edit script over arbitrary token arrays. */
function myers<T>(a: T[], b: T[]): Edit[] {
  // Trim common prefix/suffix: the common case for source edits and a big speed-up.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const edits: Edit[] = [];
  for (let i = 0; i < pre; i++) edits.push({ t: "=", a: i, b: i });

  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i++) edits.push({ t: "-", a: pre + i, b: pre });
    for (let j = 0; j < m; j++) edits.push({ t: "+", a: pre + n, b: pre + j });
  } else {
    const max = n + m;
    const off = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
    }
    // Backtrack
    const rev: Edit[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const vv = trace[d]!;
      const k = x - y;
      const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1;
      const prevX = vv[off + prevK]!;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x--;
        y--;
        rev.push({ t: "=", a: pre + x, b: pre + y });
      }
      if (d > 0) {
        if (x === prevX) rev.push({ t: "+", a: pre + x, b: pre + prevY });
        else rev.push({ t: "-", a: pre + prevX, b: pre + y });
      }
      x = prevX;
      y = prevY;
    }
    v = new Int32Array(0);
    edits.push(...rev.reverse());
  }
  for (let i = 0; i < suf; i++) edits.push({ t: "=", a: a.length - suf + i, b: b.length - suf + i });
  return edits;
}

export interface Hunk {
  /** Stable id derived from position and content. */
  id: string;
  /** Index into the old lines where this hunk starts (0-based). */
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** Group a line diff into hunks (maximal runs of changes, no context). */
export function diffHunks(oldLines: string[], newLines: string[]): Hunk[] {
  const edits = myers(oldLines, newLines);
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const e of edits) {
    if (e.t === "=") {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { id: "", oldStart: e.a, oldLines: [], newLines: [] };
      hunks.push(cur);
    }
    if (e.t === "-") cur.oldLines.push(oldLines[e.a]!);
    else cur.newLines.push(newLines[e.b]!);
  }
  for (const h of hunks) h.id = `${h.oldStart}:${hash(h.oldLines.join("\n") + "\u0000" + h.newLines.join("\n"))}`;
  return hunks;
}

/** Apply the hunks for which `accept` is true to the old lines; rejected hunks keep their old lines. */
export function applyHunks(oldLines: string[], hunks: Hunk[], accept: (h: Hunk) => boolean): string[] {
  const out: string[] = [];
  let i = 0;
  for (const h of hunks) {
    while (i < h.oldStart) out.push(oldLines[i++]!);
    if (accept(h)) out.push(...h.newLines);
    else out.push(...h.oldLines);
    i = h.oldStart + h.oldLines.length;
  }
  while (i < oldLines.length) out.push(oldLines[i++]!);
  return out;
}

export interface DiffStats { added: number; removed: number }
export function statsOf(hunks: Hunk[]): DiffStats {
  return { added: hunks.reduce((n, h) => n + h.newLines.length, 0), removed: hunks.reduce((n, h) => n + h.oldLines.length, 0) };
}

export interface Segment { text: string; changed: boolean }

const WORD = /\w+|\s+|[^\w\s]/g;

/** Word-level highlight of one changed line pair. */
export function wordDiff(oldLine: string, newLine: string): { old: Segment[]; new: Segment[] } {
  const a = oldLine.match(WORD) ?? [];
  const b = newLine.match(WORD) ?? [];
  const edits = myers(a, b);
  const o: Segment[] = [];
  const n: Segment[] = [];
  const push = (arr: Segment[], text: string, changed: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text;
    else arr.push({ text, changed });
  };
  for (const e of edits) {
    if (e.t === "=") {
      push(o, a[e.a]!, false);
      push(n, b[e.b]!, false);
    } else if (e.t === "-") push(o, a[e.a]!, true);
    else push(n, b[e.b]!, true);
  }
  return { old: o, new: n };
}

/** Context lines around a hunk, for display. */
export function withContext(oldLines: string[], h: Hunk, context = 3): { before: string[]; after: string[]; startLine: number } {
  const s = Math.max(0, h.oldStart - context);
  const afterStart = h.oldStart + h.oldLines.length;
  return { before: oldLines.slice(s, h.oldStart), after: oldLines.slice(afterStart, afterStart + context), startLine: s + 1 };
}
