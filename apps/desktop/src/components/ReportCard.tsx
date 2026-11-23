import type { VerificationReport } from "@forge/verify";
import { formatError } from "@forge/verify";

const KIND_LABEL: Record<string, string> = { format: "Format", lint: "Lint", typecheck: "Types", diagnostics: "Language server", test: "Tests" };

/** Verification report card: checks run, pass/fail per check, tests added/changed, and what was not verified. */
export function ReportCard({ report, source }: { report: VerificationReport; source?: string }) {
  const failed = report.checks.some((c) => !c.ok && !c.skipped);
  const label = report.verified ? "Verified" : failed ? "Checks failed" : report.checks.some((c) => !c.skipped) ? "Fast checks passed" : "Unverified";
  const tone = report.verified ? "text-green-400" : failed ? "text-red-400" : "text-amber-400";
  return (
    <div className="rounded border border-[var(--border)] p-2 text-xs" data-testid="report-card">
      <div className="flex items-center gap-2">
        <strong className={tone} data-testid="report-label">{label}</strong>
        <span className="text-[var(--muted)]">{report.phase} run{source ? `, ${source}` : ""}</span>
      </div>
      <ul className="mt-1 space-y-0.5">
        {report.checks.map((c, i) => (
          <li key={i} data-testid="report-check">
            <span className={c.skipped ? "text-[var(--muted)]" : c.ok ? "text-green-400" : "text-red-400"}>{c.skipped ? "-" : c.ok ? "✓" : "✗"}</span> {KIND_LABEL[c.kind] ?? c.kind}
            {!c.ok && !c.skipped && <span className="text-[var(--muted)]"> ({c.errors.length || "see output"})</span>}
            {!c.ok && c.errors.slice(0, 5).map((e, j) => (
              <div key={j} className="ml-4 truncate text-[var(--muted)]" title={formatError(e)}>{formatError(e)}</div>
            ))}
            {!c.ok && c.errors.length === 0 && c.rawTail && <pre className="ml-4 max-h-24 overflow-auto whitespace-pre-wrap text-[var(--muted)]">{c.rawTail}</pre>}
          </li>
        ))}
      </ul>
      {(report.testsAdded.length > 0 || report.testsChanged.length > 0) && (
        <div className="mt-1">
          {report.testsAdded.length > 0 && <div>Tests added: {report.testsAdded.join(", ")}</div>}
          {report.testsChanged.length > 0 && <div>Tests changed: {report.testsChanged.join(", ")}</div>}
        </div>
      )}
      {report.unverified.length > 0 && (
        <ul className="mt-1 text-amber-300" data-testid="report-unverified">
          {report.unverified.map((u, i) => (
            <li key={i}>Not verified: {u}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
