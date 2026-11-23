import { useEffect, useState } from "react";
import { latestOnly } from "../lib/latestOnly";
import { addStepComment, progress, validatePlan, type Plan, type StepStatus } from "@forge/plans";
import type { WorkspaceServices } from "../lib/workspace";

const ICON: Record<StepStatus, { sym: string; cls: string; label: string }> = {
  pending: { sym: "○", cls: "text-[var(--muted)]", label: "pending" },
  "in-progress": { sym: "◔", cls: "text-amber-400", label: "in progress" },
  verified: { sym: "✓", cls: "text-green-400", label: "verified" },
  failed: { sym: "✗", cls: "text-red-400", label: "failed" },
};

interface Props {
  services: WorkspaceServices;
  version: number;
  slug: string | null;
  building: boolean;
  onSelect: (slug: string) => void;
  onBuild: (slug: string) => void;
  onPause: () => void;
  onEditFile: (absPath: string) => void;
  onClose: () => void;
}

export function PlanPane({ services, version, slug, building, onSelect, onBuild, onPause, onEditFile, onClose }: Props) {
  const [list, setList] = useState<{ slug: string; plan: Plan }[]>([]);
  const [comment, setComment] = useState<{ n: number; text: string } | null>(null);

  useEffect(() => {
    const load = latestOnly(setList);
    load.run(services.plans.list());
    return load.cancel;
  }, [services, version]);

  const current = list.find((x) => x.slug === slug) ?? list[0];
  const plan = current?.plan;
  const problems = plan ? validatePlan(plan) : [];
  const blocking = problems.filter((p) => p.severity === "error");
  const prog = plan ? progress(plan) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="plan-pane" aria-label="Plan">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm">
        <strong>Plan</strong>
        {list.length > 0 && (
          <select aria-label="Plan" className="rounded bg-[var(--hover)] px-1" value={current?.slug} onChange={(e) => onSelect(e.target.value)}>
            {list.map((x) => (
              <option key={x.slug} value={x.slug}>{x.plan.title}</option>
            ))}
          </select>
        )}
        {plan && <span className="text-xs text-[var(--muted)]" data-testid="plan-status">{plan.status} · {prog!.done}/{prog!.total} verified</span>}
        <span className="ml-auto flex gap-2">
          {current && (
            <button className="rounded bg-[var(--hover)] px-2" data-testid="plan-edit" onClick={() => onEditFile(services.plans.abs(current.slug))}>Edit file</button>
          )}
          {current && !building && prog?.next && (
            <button className="rounded bg-green-700/70 px-3" data-testid="plan-build" disabled={blocking.length > 0} title={blocking.length ? "Fix the plan first" : ""} onClick={() => onBuild(current.slug)}>
              {plan!.steps.some((s) => s.status === "verified" || s.status === "failed") ? "Resume build" : "Build"}
            </button>
          )}
          {building && (
            <button className="rounded bg-amber-700/70 px-3" data-testid="plan-pause" onClick={onPause}>Pause</button>
          )}
          <button className="underline" onClick={onClose}>Close</button>
        </span>
      </div>
      {!plan ? (
        <div className="p-4 text-sm text-[var(--muted)]" data-testid="plan-empty">
          No plan yet. Switch the agent to Plan mode and describe what you want to build; the plan is written to .forge/plans/ for you to review and edit.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
          <h2 className="mb-1 text-lg font-semibold">{plan.title}</h2>
          <p className="mb-3" data-testid="plan-goal">{plan.goal}</p>
          {problems.length > 0 && (
            <ul className="mb-3 space-y-0.5 text-xs" data-testid="plan-problems">
              {problems.map((p, i) => (
                <li key={i} className={p.severity === "error" ? "text-red-400" : "text-amber-300"}>{p.severity === "error" ? "Error: " : "Note: "}{p.message}</li>
              ))}
            </ul>
          )}
          <Section title="Assumptions" items={plan.assumptions} />
          <Section title="Files to change" items={plan.filesToChange.map((f) => `${f.path}${f.reason ? ` — ${f.reason}` : ""}`)} />
          <Section title="Files to create" items={plan.filesToCreate.map((f) => `${f.path}${f.reason ? ` — ${f.reason}` : ""}`)} />
          <h3 className="mb-1 mt-3 font-semibold">Tasks</h3>
          <ol className="space-y-2" data-testid="plan-steps">
            {plan.steps.map((s) => (
              <li key={s.n} className="rounded border border-[var(--border)] p-2" data-testid="plan-step" data-status={s.status}>
                <div className="flex items-start gap-2">
                  <span className={`${ICON[s.status].cls} text-base leading-5`} title={ICON[s.status].label} data-testid="step-icon">{ICON[s.status].sym}</span>
                  <div className="min-w-0 flex-1">
                    <div><span className="text-[var(--muted)]">Step {s.n}.</span> <strong>{s.title}</strong> <span className="text-xs text-[var(--muted)]">({ICON[s.status].label})</span></div>
                    {s.acceptance && <div className="text-xs text-[var(--muted)]">Acceptance: {s.acceptance}</div>}
                    {s.files.length > 0 && <div className="text-xs text-[var(--muted)]">Files: {s.files.join(", ")}</div>}
                    {s.comments.map((c, i) => (
                      <div key={i} className="mt-0.5 border-l-2 border-[var(--border)] pl-2 text-xs">{c}</div>
                    ))}
                    {comment?.n === s.n ? (
                      <div className="mt-1 flex gap-1">
                        <input aria-label={`Comment on step ${s.n}`} className="flex-1 rounded bg-[var(--hover)] px-1 text-xs" value={comment.text} onChange={(e) => setComment({ n: s.n, text: e.target.value })} />
                        <button className="rounded bg-[var(--hover)] px-2 text-xs" onClick={() => { if (comment.text.trim()) void services.plans.edit(plan.slug, (md) => addStepComment(md, s.n, comment.text.trim())); setComment(null); }}>Add</button>
                      </div>
                    ) : (
                      <button className="mt-1 text-xs underline" onClick={() => setComment({ n: s.n, text: "" })}>Comment</button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <Section title="Risks" items={plan.risks} />
          <Section title="Out of scope" items={plan.outOfScope} />
        </div>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h3 className="mb-1 mt-3 font-semibold">{title}</h3>
      <ul className="list-disc space-y-0.5 pl-5">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </>
  );
}
