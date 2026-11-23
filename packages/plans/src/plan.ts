// Plan files: Markdown in .forge/plans/<slug>.md. Humans edit them directly, so parsing is forgiving and
// status/comment updates edit the text in place instead of regenerating the document.

export type StepStatus = "pending" | "in-progress" | "verified" | "failed";
export type PlanStatus = "draft" | "approved" | "building" | "paused" | "done";

export interface PlanStep {
  n: number;
  title: string;
  status: StepStatus;
  acceptance: string;
  files: string[];
  comments: string[];
}

export interface FileEntry { path: string; reason: string }

export interface Plan {
  slug: string;
  title: string;
  status: PlanStatus;
  goal: string;
  assumptions: string[];
  filesToChange: FileEntry[];
  filesToCreate: FileEntry[];
  steps: PlanStep[];
  risks: string[];
  outOfScope: string[];
}

const MARK: Record<StepStatus, string> = { pending: " ", "in-progress": "~", verified: "x", failed: "!" };
const FROM_MARK: Record<string, StepStatus> = { " ": "pending", "~": "in-progress", x: "verified", X: "verified", "!": "failed" };

export const slugify = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";

export const planPath = (slug: string) => `.forge/plans/${slug}.md`;

/** Split the markdown into level-2 sections keyed by lowercase heading. */
function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const parts = body.split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    out.set((nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase(), nl < 0 ? "" : part.slice(nl + 1));
  }
  return out;
}

const bullets = (text: string | undefined): string[] =>
  (text ?? "")
    .split("\n")
    .map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x && !/^none\b/i.test(x));

function fileEntries(text: string | undefined): FileEntry[] {
  return bullets(text).map((b) => {
    const m = /^`([^`]+)`\s*(?:[-—:]\s*(.*))?$/.exec(b) ?? /^(\S+)\s*(?:[-—:]\s*(.*))?$/.exec(b);
    return { path: (m?.[1] ?? b).replace(/\\/g, "/"), reason: m?.[2]?.trim() ?? "" };
  });
}

export function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const out: Record<string, string> = {};
  for (const line of m?.[1]?.split("\n") ?? []) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

const STEP = /^(\d+)\.\s+\[([ xX~!])\]\s+(.*)$/;

function parseSteps(text: string | undefined): PlanStep[] {
  const steps: PlanStep[] = [];
  let cur: PlanStep | null = null;
  for (const line of (text ?? "").split("\n")) {
    const m = STEP.exec(line);
    if (m) {
      const [, n, mark, rest] = m;
      const title = rest!.replace(/\*\*/g, "").split(/\s+[—-]\s+acceptance:/i)[0]!.trim();
      const inlineAcc = /acceptance:\s*(.*)$/i.exec(rest!)?.[1]?.trim() ?? "";
      cur = { n: Number(n), title, status: FROM_MARK[mark!] ?? "pending", acceptance: inlineAcc, files: [], comments: [] };
      steps.push(cur);
      continue;
    }
    if (!cur) continue;
    const sub = /^\s+[-*]\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) cur.comments.push(quote[1]!.trim());
    else if (sub) {
      const acc = /^acceptance:\s*(.*)$/i.exec(sub[1]!);
      const files = /^files?:\s*(.*)$/i.exec(sub[1]!);
      if (acc) cur.acceptance = acc[1]!.trim();
      else if (files) cur.files.push(...files[1]!.split(",").map((f) => f.replace(/[`\s]/g, "").replace(/\\/g, "/")).filter(Boolean));
    }
  }
  return steps;
}

export function parsePlan(md: string, slug = "plan"): Plan {
  const fm = parseFrontmatter(md);
  const sec = sections(md);
  const title = fm.title || /^#\s+(.+)$/m.exec(md)?.[1]?.trim() || slug;
  return {
    slug,
    title,
    status: (["draft", "approved", "building", "paused", "done"].includes(fm.status ?? "") ? fm.status : "draft") as PlanStatus,
    goal: (sec.get("goal") ?? "").trim(),
    assumptions: bullets(sec.get("assumptions")),
    filesToChange: fileEntries(sec.get("files to change")),
    filesToCreate: fileEntries(sec.get("files to create")),
    steps: parseSteps(sec.get("tasks") ?? sec.get("steps")),
    risks: bullets(sec.get("risks")),
    outOfScope: bullets(sec.get("out of scope") ?? sec.get("out-of-scope")),
  };
}

export interface PlanProblem { severity: "error" | "warning"; message: string }

/** A plan must be checkable before it can be built. */
export function validatePlan(p: Plan): PlanProblem[] {
  const out: PlanProblem[] = [];
  if (!p.goal) out.push({ severity: "error", message: "The plan has no Goal section." });
  if (p.steps.length === 0) out.push({ severity: "error", message: "The plan has no tasks. Add numbered steps like `1. [ ] **Title** — acceptance: ...`." });
  for (const s of p.steps) if (!s.acceptance) out.push({ severity: "error", message: `Step ${s.n} (${s.title}) has no acceptance check.` });
  const nums = p.steps.map((s) => s.n);
  if (nums.some((n, i) => n !== i + 1)) out.push({ severity: "warning", message: "Step numbers are not consecutive from 1." });
  if (p.filesToChange.length + p.filesToCreate.length === 0 && p.steps.every((s) => s.files.length === 0)) out.push({ severity: "warning", message: "No files are listed; every edit will need your approval." });
  if (p.risks.length === 0) out.push({ severity: "warning", message: "No risks listed." });
  return out;
}

/** Files the agent may touch while building this plan (workspace-relative, forward slashes). */
export function allowedFiles(p: Plan): Set<string> {
  return new Set([...p.filesToChange, ...p.filesToCreate].map((f) => f.path).concat(p.steps.flatMap((s) => s.files)));
}

// ---------- in-place edits ----------

export function setStepStatus(md: string, n: number, status: StepStatus): string {
  const re = new RegExp(`^(${n}\\.\\s+)\\[[ xX~!]\\]`, "m");
  return md.replace(re, `$1[${MARK[status]}]`);
}

export function setPlanStatus(md: string, status: PlanStatus): string {
  if (/^---\n[\s\S]*?\n---/.test(md)) {
    return /^status:/m.test(md.split("\n---")[0]!) ? md.replace(/^status:.*$/m, `status: ${status}`) : md.replace(/^---\n/, `---\nstatus: ${status}\n`);
  }
  return `---\nstatus: ${status}\n---\n${md}`;
}

/** Add a reviewer comment under a step as a blockquote line. */
export function addStepComment(md: string, n: number, text: string): string {
  const lines = md.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^${n}\\.\\s+\\[[ xX~!]\\]`).test(l));
  if (idx < 0) return md;
  let end = idx + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]!) || /^\s*>/.test(lines[end]!))) end++;
  lines.splice(end, 0, `   > ${text.replace(/\n/g, " ")}`);
  return lines.join("\n");
}

/** Add a path to "Files to change" (used when the developer approves an out-of-plan edit). */
export function addFileToPlan(md: string, path: string, reason: string, create = false): string {
  const heading = create ? "Files to create" : "Files to change";
  const entry = `- \`${path}\` — ${reason}`;
  const re = new RegExp(`(^##\\s+${heading}\\s*\\n)([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m");
  if (re.test(md)) return md.replace(re, (_m, h: string, body: string) => `${h}${body.replace(/\s*$/, "")}\n${entry}\n\n`);
  return `${md.replace(/\s*$/, "")}\n\n## ${heading}\n${entry}\n`;
}

export function progress(p: Plan): { done: number; total: number; next?: PlanStep } {
  return { done: p.steps.filter((s) => s.status === "verified").length, total: p.steps.length, next: p.steps.find((s) => s.status !== "verified") };
}

export const PLAN_TEMPLATE = `---
title: <short title>
status: draft
---
# <short title>

## Goal
One or two sentences: what will be true when this is done.

## Assumptions
- Things you assumed because the request did not say.

## Files to change
- \`path/to/file.ts\` — why it changes

## Files to create
- \`path/to/new.ts\` — what it is for

## Tasks
1. [ ] **First step** — acceptance: a concrete check, e.g. \`npm test -- csv\` passes
   - files: path/to/file.ts, path/to/new.ts
2. [ ] **Second step** — acceptance: ...
   - files: path/to/other.ts

## Risks
- What could go wrong, and how you will notice.

## Out of scope
- What this plan deliberately does not do.
`;

const PLAN_MODE_PROMPT = `You are in PLAN mode. Do not try to change code: you can only read, ask questions and write the plan file.
Workflow:
1. Research with repo_map, semantic_search, grep, find_files, symbol, references and dependency_cone. List the files you read.
2. If the request is ambiguous, call ask_user ONCE with at most 3 targeted questions, each with a suggested default.
3. Call write_plan with a complete plan in exactly this structure. Every task needs an acceptance check that can be verified by running something.
4. Before changing a shared symbol, call references and list every affected file under "Files to change".
Plan structure:
${PLAN_TEMPLATE}
After writing the plan, stop and tell the developer to review and edit it. Never start building on your own.`;

const AGENT_MODE_PROMPT = `You are in AGENT mode: you may edit files (changes go to the developer for review) and run the project's checks. Prefer existing utilities and patterns found via the index; if you add a new pattern, say why. Before editing a shared symbol, call references and account for every caller.`;

/** Extra system-prompt text for a mode. */
export function modePrompt(mode: "ask" | "plan" | "agent" | "debug"): string | undefined {
  if (mode === "plan") return PLAN_MODE_PROMPT;
  if (mode === "agent") return AGENT_MODE_PROMPT;
  if (mode === "debug") return `${AGENT_MODE_PROMPT}\nDEBUG mode: first reproduce the problem and capture the exact error, form a hypothesis, instrument or fix minimally, then confirm the original reproduction now passes.`;
  return undefined;
}
