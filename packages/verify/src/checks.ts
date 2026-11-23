import type { Exec } from "./exec";
import type { ProjectCommands } from "./discovery";
import { formatError, parseOutput, tail, type StructuredError } from "./parsers";

export type CheckKind = "format" | "lint" | "typecheck" | "diagnostics" | "test";

export interface CheckResult {
  kind: CheckKind;
  command: string;
  ok: boolean;
  skipped?: string;
  durationMs: number;
  errors: StructuredError[];
  omitted: number;
  /** Truncated raw tail, only when nothing could be parsed from a failure. */
  rawTail?: string;
}

export interface VerificationReport {
  phase: "fast" | "full";
  attempt: number;
  checks: CheckResult[];
  testsAdded: string[];
  testsChanged: string[];
  /** Things that could not be verified, e.g. "no tests cover src/x.ts". */
  unverified: string[];
  /** True only for a full run in which every configured check passed. */
  verified: boolean;
  summary: string;
}

export interface TouchedFile {
  /** path relative to the workspace root, forward slashes */
  path: string;
  created: boolean;
}

export const isTestFile = (p: string) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i.test(p);

export interface RunChecksOptions {
  commands: ProjectCommands;
  exec: Exec;
  cwd: string;
  phase: "fast" | "full";
  touched: TouchedFile[];
  attempt?: number;
  /** Test files covering the touched files (from the dependency graph). */
  relatedTests?: (files: string[]) => Promise<string[]>;
  /** Current LSP diagnostics for the touched files. */
  diagnostics?: (files: string[]) => Promise<StructuredError[]>;
  timeoutMs?: Partial<Record<CheckKind, number>>;
  onProgress?: (msg: string) => void;
}

const DEFAULT_TIMEOUT: Record<CheckKind, number> = { format: 120_000, lint: 180_000, typecheck: 300_000, diagnostics: 1000, test: 600_000 };

const quote = (p: string) => `"${p.replace(/"/g, "")}"`;
const safePath = (p: string) => !/["\r\n`$]/.test(p);

/** Substitute {files} / {file}. Returns null when the template needs files but none are safe to pass. */
export function fillTemplate(cmd: string, files: string[]): string | null {
  const safe = files.filter(safePath);
  if (/\{files?\}/.test(cmd) && safe.length === 0) return null;
  return cmd.replace(/\{files\}/g, safe.map(quote).join(" ")).replace(/\{file\}/g, safe[0] ? quote(safe[0]) : "");
}

async function runOne(kind: CheckKind, command: string, o: RunChecksOptions): Promise<CheckResult> {
  o.onProgress?.(`${kind}: ${command}`);
  const r = await o.exec.run(command, { cwd: o.cwd, timeoutMs: o.timeoutMs?.[kind] ?? DEFAULT_TIMEOUT[kind] });
  const output = `${r.stdout}\n${r.stderr}`;
  const ok = r.code === 0 && !r.timedOut;
  const { errors, omitted } = ok ? { errors: [], omitted: 0 } : parseOutput(output, { kind: kind === "diagnostics" ? undefined : kind });
  return {
    kind,
    command,
    ok,
    durationMs: r.millis,
    errors,
    omitted,
    rawTail: !ok && errors.length === 0 ? (r.timedOut ? `timed out after ${(o.timeoutMs?.[kind] ?? DEFAULT_TIMEOUT[kind]) / 1000}s\n` : "") + tail(output) : undefined,
  };
}

/** A `diagnostics` entry with this rule is not a problem in the code: it says the file could not be checked, and why. */
export const UNCHECKED = "unchecked";

export async function runChecks(o: RunChecksOptions): Promise<VerificationReport> {
  const files = o.touched.map((t) => t.path);
  const checks: CheckResult[] = [];
  const unverified: string[] = [];
  const { commands: c } = o;

  const scoped = async (kind: CheckKind, cmd: string | undefined, label: string) => {
    if (!cmd) {
      unverified.push(`no ${label} command configured (add it under ## Commands in AGENTS.md)`);
      return;
    }
    const filled = fillTemplate(cmd, files);
    if (filled === null) return void checks.push({ kind, command: cmd, ok: true, skipped: "no files to check", durationMs: 0, errors: [], omitted: 0 });
    checks.push(await runOne(kind, filled, o));
  };

  await scoped("format", c.format, "format");
  await scoped("lint", c.lint, "lint");
  await scoped("typecheck", c.typecheck, "typecheck");

  if (o.diagnostics && files.length) {
    const found = await o.diagnostics(files);
    const errs = found.filter((e) => e.severity === "error");
    checks.push({ kind: "diagnostics", command: "LSP diagnostics", ok: errs.length === 0, durationMs: 0, errors: errs.slice(0, 40), omitted: Math.max(0, errs.length - 40) });
    // Files the language server could not check (not installed, too slow): "no errors" would say more than is known.
    const gaps = found.filter((e) => e.severity === "warning" && e.rule === UNCHECKED);
    if (gaps.length) {
      const shown = gaps.slice(0, 3).map((g) => `${g.file} (${g.message})`);
      unverified.push(`the language server could not check ${gaps.length} file${gaps.length === 1 ? "" : "s"}: ${shown.join(", ")}${gaps.length > 3 ? `, and ${gaps.length - 3} more` : ""}`);
    }
  }

  // Tests: related tests first; the full suite only for the final check.
  let related: string[] = [];
  const sources = files.filter((f) => !isTestFile(f));
  if (o.relatedTests && sources.length) {
    related = [...new Set([...(await o.relatedTests(sources)), ...files.filter(isTestFile)])];
    for (const f of sources) {
      const covering = await o.relatedTests([f]);
      if (covering.length === 0 && !files.some((x) => isTestFile(x))) unverified.push(`no tests cover ${f}`);
    }
  } else related = files.filter(isTestFile);

  if (o.phase === "fast") {
    if (related.length && c.testFile) {
      for (const f of related.slice(0, 5)) {
        const cmd = fillTemplate(c.testFile, [f]);
        if (cmd) checks.push(await runOne("test", cmd, o));
      }
    } else if (related.length && c.test) {
      checks.push(await runOne("test", c.test, o));
    }
  } else if (c.test) {
    checks.push(await runOne("test", c.test, o));
  } else {
    unverified.push("no test command configured (add it under ## Commands in AGENTS.md)");
  }

  const ran = checks.filter((k) => !k.skipped);
  const failed = ran.filter((k) => !k.ok);
  const verified = o.phase === "full" && ran.length > 0 && failed.length === 0;
  const testsAdded = o.touched.filter((t) => t.created && isTestFile(t.path)).map((t) => t.path);
  const testsChanged = o.touched.filter((t) => !t.created && isTestFile(t.path)).map((t) => t.path);
  const summary =
    failed.length > 0
      ? `Failed: ${failed.map((k) => `${k.kind} (${k.errors.length || "?"})`).join(", ")}`
      : ran.length === 0
        ? "Unverified: no checks ran"
        : verified
          ? "Verified: all configured checks passed"
          : `Fast checks passed (${ran.map((k) => k.kind).join(", ")}); full verification not run yet`;
  return { phase: o.phase, attempt: o.attempt ?? 1, checks, testsAdded, testsChanged, unverified, verified, summary };
}

/** Report for edits that are not on disk yet (pending review): nothing can be verified. */
export function unverifiedReport(reason: string): VerificationReport {
  return { phase: "full", attempt: 0, checks: [], testsAdded: [], testsChanged: [], unverified: [reason], verified: false, summary: `Unverified: ${reason}` };
}

/** The message fed back to the model after a failed run. Structured, deduplicated, bounded. */
export function feedbackMessage(report: VerificationReport, attempt: number, max: number): string {
  const lines = [`Automated checks failed (attempt ${attempt} of ${max}).`];
  for (const k of report.checks.filter((c) => !c.ok && !c.skipped)) {
    lines.push(`FAILED ${k.kind} (${k.command}): ${k.errors.length || "unparsed"} problem(s)`);
    for (const e of k.errors.slice(0, 15)) lines.push(`- ${formatError(e)}`);
    if (k.errors.length > 15 || k.omitted) lines.push(`- ... and ${Math.max(0, k.errors.length - 15) + k.omitted} more`);
    if (k.rawTail) lines.push(k.rawTail);
  }
  lines.push(
    "Fix the root cause in the code under test. Do NOT delete, skip or weaken tests, and do NOT add lint or type suppressions (eslint-disable, @ts-ignore, # noqa, ...). If you believe a test itself is wrong, stop and explain why instead of editing it.",
  );
  return lines.join("\n");
}

export const finalFailureMessage = (report: VerificationReport, attempts: number) =>
  `Verification is still failing after ${attempts} attempts. Stop editing. Write a short report: what you tried, the remaining error(s), and your best hypothesis about the root cause. Remaining: ${report.checks
    .filter((c) => !c.ok && !c.skipped)
    .flatMap((c) => c.errors.slice(0, 5).map(formatError))
    .join("; ")}`;

/** Plain-text rendering of a report (tool output, logs). */
export function formatReport(r: VerificationReport): string {
  const lines = [`${r.summary} (${r.phase} run${r.attempt ? `, attempt ${r.attempt}` : ""})`];
  for (const k of r.checks) {
    const state = k.skipped ? `skipped (${k.skipped})` : k.ok ? "passed" : "FAILED";
    lines.push(`- ${k.kind}: ${state}${k.skipped ? "" : ` [${k.command}]`}`);
    for (const e of k.errors.slice(0, 10)) lines.push(`    ${formatError(e)}`);
    if (k.rawTail) lines.push(`    ${k.rawTail.split("\n").join("\n    ")}`);
  }
  if (r.testsAdded.length) lines.push(`Tests added: ${r.testsAdded.join(", ")}`);
  if (r.testsChanged.length) lines.push(`Tests changed: ${r.testsChanged.join(", ")}`);
  for (const u of r.unverified) lines.push(`Not verified: ${u}`);
  return lines.join("\n");
}
