import { splitLines, type Hunk } from "@forge/review";

const CONTEXT = 2;

/** Unified-style diff for one file, built from the review model's hunks (with a little context from the original). */
export function unifiedDiff(path: string, base: string | null, hunks: Hunk[]): string {
  const old = splitLines(base ?? "");
  // Splitting on newlines yields a phantom empty element after a trailing newline. It is not a real line, so keep it
  // out of the context and out of hunks that merely end at it.
  const real = base !== null && base.endsWith("\n") ? old.length - 1 : base === null || base === "" ? 0 : old.length;
  const out = [`--- ${base === null ? "/dev/null" : "a/" + path}`, `+++ b/${path}`];
  let delta = 0;
  for (const raw of hunks) {
    const atEof = raw.oldStart + raw.oldLines.length === old.length && raw.oldLines.at(-1) === "" && raw.newLines.at(-1) === "";
    const h = atEof ? { ...raw, oldLines: raw.oldLines.slice(0, -1), newLines: raw.newLines.slice(0, -1) } : raw;
    const ctxBefore = old.slice(Math.max(0, h.oldStart - CONTEXT), h.oldStart);
    const after = h.oldStart + h.oldLines.length;
    const ctxAfter = old.slice(after, Math.min(after + CONTEXT, real));
    const oldCount = ctxBefore.length + h.oldLines.length + ctxAfter.length;
    const newCount = ctxBefore.length + h.newLines.length + ctxAfter.length;
    const start = h.oldStart - ctxBefore.length + 1;
    out.push(`@@ -${oldCount === 0 ? 0 : start},${oldCount} +${newCount === 0 ? 0 : start + delta},${newCount} @@`);
    out.push(...ctxBefore.map((l) => " " + l), ...h.oldLines.map((l) => "-" + l), ...h.newLines.map((l) => "+" + l), ...ctxAfter.map((l) => " " + l));
    delta += h.newLines.length - h.oldLines.length;
  }
  return out.join("\n");
}
