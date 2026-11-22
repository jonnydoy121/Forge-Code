import { FileCheckpointStore, type CheckpointFs } from "@forge/checkpoints";
import { PendingChanges, type ReviewMode } from "@forge/review";
import { createEditTools, type EditSink, type FsBackend, type RegisteredTool } from "@forge/tool-host";
import {
  HookRunner,
  createVerifyTools,
  detectWeakening,
  loadCommands,
  parseHooksConfig,
  runChecks,
  withCommandsSection,
  type Exec,
  type ProjectCommands,
  type StructuredError,
  type VerificationReport,
} from "@forge/verify";
import { createPermissionGate, type AskRequest, type Remember } from "@forge/safety";
import { PlanGuard, PlanStore, createPlanTools, type Question } from "@forge/plans";
import { DocsStore, MemoryStore, RuleEngine, SessionStore, collectFacts, createContextTools, generateAgentsMd, lintRules, type LintWarning, type ProjectFacts } from "@forge/context-store";
import { loadSettings } from "./settings";
import { fetchText } from "./http";
import type { Runtime, VerifyDeps } from "@forge/agent-runtime";
import { invoke } from "@tauri-apps/api/core";
import { fsApi, indexBackend } from "./ipc";

export const norm = (p: string) => p.split("\\").join("/");

/** Workspace file access with "missing file" as null, over Tauri IPC. */
export const diskFs: CheckpointFs = {
  read: (path) => invoke<string | null>("read_file_opt", { path }),
  write: fsApi.writeFile,
  remove: (path) => invoke<void>("remove_file", { path }),
  list: (path) => invoke<string[]>("list_names", { path }),
};

export interface GitResult { ok: boolean; stdout: string; stderr: string }
export const git = (root: string, args: string[]) => invoke<GitResult>("git_run", { root, args });

export const tauriExec: Exec = {
  run: async (command, o) => {
    const r = await invoke<{ code: number | null; stdout: string; stderr: string; timed_out: boolean; millis: number }>("run_command", {
      cwd: o.cwd,
      command,
      timeoutMs: o.timeoutMs,
      env: Object.entries(o.env ?? {}),
    });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timed_out, millis: r.millis };
  },
};

export interface ReportEvent { report: VerificationReport; source: "agent" | "accepted-changes" | "manual"; seq: number }

export interface WorkspaceServices {
  root: string;
  sessionId: string;
  pending: PendingChanges;
  checkpoints: FileCheckpointStore;
  /** Reads see pending proposals layered over disk. */
  overlay(base: FsBackend): FsBackend;
  editTools: RegisteredTool[];
  verifyTools: RegisteredTool[];
  verifyDeps: VerifyDeps;
  hooks: HookRunner;
  gate: ReturnType<typeof createPermissionGate>;
  setRuntime(rt: Runtime | null): void;
  commands(): Promise<ProjectCommands>;
  /** Run checks on demand ("Run checks" button). */
  runVerification(phase: "fast" | "full"): Promise<VerificationReport>;
  /** Propose a `## Commands` section for AGENTS.md as a reviewable change, if the file lacks one. */
  proposeCommandsSection(): Promise<"proposed" | "exists" | "nothing-detected">;
  hookErrors: string[];
  plans: PlanStore;
  planGuard: PlanGuard;
  planTools: RegisteredTool[];
  rules: RuleEngine;
  memories: MemoryStore;
  docs: DocsStore;
  sessions: SessionStore;
  contextTools: RegisteredTool[];
  /** Detected project facts (stack, config, code conventions) for linting and rule generation. */
  facts(): Promise<ProjectFacts>;
  /** Rules that contradict the project's own configuration, or contain secrets. */
  lintAll(): Promise<LintWarning[]>;
  /** Draft an AGENTS.md from the repo and propose it as a reviewable change. */
  proposeGeneratedRules(): Promise<void>;
}

const SESSION_KEY = "forge.session.v1";

/** One session id per workspace, remembered so checkpoints survive restarts. */
function sessionIdFor(root: string): string {
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}") as Record<string, string>;
    if (!all[root]) {
      all[root] = `s-${Date.now().toString(36)}`;
      localStorage.setItem(SESSION_KEY, JSON.stringify(all));
    }
    return all[root]!;
  } catch {
    return `s-${Date.now().toString(36)}`;
  }
}

export async function createWorkspaceServices(opts: {
  root: string;
  mode: () => ReviewMode;
  planFiles?: () => string[] | null;
  onChange: () => void;
  onReport: (e: ReportEvent) => void;
  onHook: (event: string, output: string) => void;
  /** Ask the developer to approve an execute/network tool call. */
  ask: (req: AskRequest) => Promise<Remember>;
  /** Current LSP diagnostics for workspace-relative files. */
  diagnostics: (files: string[]) => Promise<StructuredError[]>;
  /** Plan mode: clarifying questions with suggested defaults. */
  askQuestions: (qs: Question[]) => Promise<string[]>;
  /** Build: "Step 3 also needs utils/date.ts. Add it?" */
  askAddFile: (question: string, path: string, step: number | undefined) => Promise<boolean>;
  onPlanWritten: (slug: string) => void;
  onBlocked: (path: string, message: string) => void;
  /** Shown to the developer whenever the agent creates a memory itself. */
  onMemoryCreated: (name: string, body: string) => void;
}): Promise<WorkspaceServices> {
  const root = norm(opts.root).replace(/\/+$/, "");
  const sessionId = sessionIdFor(root);
  const checkpoints = new FileCheckpointStore({ fs: diskFs, dir: `${root}/.forge/checkpoints/${sessionId}` });
  const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  let runtime: Runtime | null = null;
  let seq = 0;

  const hooksText = await diskFs.read(`${root}/.forge/hooks.json`);
  const parsedHooks = parseHooksConfig(hooksText);
  const hooks = new HookRunner({ cwd: root, exec: tauriExec, config: parsedHooks.config });

  const commands = () => loadCommands(diskFs, root);
  const sessionTouched = new Map<string, boolean>();
  const touchedAfterAccept = new Set<string>();

  const verifyOpts = async (phase: "fast" | "full", touched: { path: string; created: boolean }[], attempt = 1) =>
    runChecks({
      commands: await commands(),
      exec: tauriExec,
      cwd: root,
      phase,
      touched,
      attempt,
      relatedTests: async (files) => {
        const tests = new Set<string>();
        for (const f of files) {
          try {
            for (const t of (await indexBackend.cone(f)).tests) tests.add(t);
          } catch {
            /* index not ready: no related tests known */
          }
        }
        return [...tests];
      },
      diagnostics: opts.diagnostics,
    });

  let verifyTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new PendingChanges({
    fs: diskFs,
    checkpoints,
    mode: opts.mode,
    planFiles: opts.planFiles,
    historyLength: () => runtime?.history.length ?? 0,
    guard: (path, base, proposed) => detectWeakening(rel(path), base, proposed),
    onChange: opts.onChange,
    onApplied: async (path, origin) => {
      const r = rel(path);
      sessionTouched.set(r, sessionTouched.get(r) ?? false);
      if (origin === "developer") touchedAfterAccept.add(r);
      const out = await hooks.run("PostEdit", { files: [r] });
      if (out.ran) opts.onHook("PostEdit", out.output);
      // Edits accepted by the developer: once nothing is left to review, verify what landed.
      clearTimeout(verifyTimer);
      verifyTimer = setTimeout(() => {
        if (pending.list().length === 0 && touchedAfterAccept.size > 0 && !runtime?.running) {
          const files = [...touchedAfterAccept].map((path) => ({ path, created: false }));
          touchedAfterAccept.clear();
          void verifyOpts("full", files).then((report) => opts.onReport({ report, source: "accepted-changes", seq: ++seq }));
        }
      }, 400);
    },
  });

  const home = await invoke<string | null>("home_dir").catch(() => null);
  const rules = new RuleEngine(diskFs, root, () => loadSettings().userRules);
  const memories = new MemoryStore(diskFs, { project: `${root}/.forge/memory`, user: home ? `${norm(home)}/.forge/memory` : undefined }, opts.onChange);
  const docs = new DocsStore(diskFs, `${root}/.forge/docs`, fetchText, opts.onChange);
  const sessions = new SessionStore(diskFs, `${root}/.forge/sessions`);
  const uniqueFiles = async (pattern: string, glob?: string) => new Set((await indexBackend.grep(pattern, glob, 5000).catch(() => [])).map((h) => h.file)).size;
  const facts = async () =>
    collectFacts(diskFs, root, {
      defaultExportFiles: await uniqueFiles("^export default"),
      namedExportFiles: await uniqueFiles("^export (const|function|class|type|interface|enum) "),
      testNaming: { test: await uniqueFiles("\\b(describe|test|it)\\(", "**/*.test.*"), spec: await uniqueFiles("\\b(describe|test|it)\\(", "**/*.spec.*") },
    });

  const plans = new PlanStore(diskFs, root, opts.onChange);
  const planGuard = new PlanGuard({ store: plans, askAddFile: opts.askAddFile, onBlocked: opts.onBlocked }, root);

  const sink: EditSink = {
    authorize: (path) => planGuard.authorize(path),
    read: async (p) => {
      const e = pending.effective(p);
      return e !== undefined ? e : diskFs.read(p);
    },
    propose: async (path, proposed, reason) => {
      const o = await pending.propose(path, proposed, reason);
      return { status: o.status, added: o.stats.added, removed: o.stats.removed, checkpoint: o.checkpoint, created: o.created, warnings: o.warnings };
    },
  };

  const gate = createPermissionGate({
    ask: opts.ask,
    load: async () => {
      try {
        const t = await diskFs.read(`${root}/.forge/permissions.json`);
        return t ? (JSON.parse(t) as { allow: { tool: string; pattern: string }[] }) : { allow: [] };
      } catch {
        return { allow: [] };
      }
    },
    save: (f) => diskFs.write(`${root}/.forge/permissions.json`, JSON.stringify(f, null, 2)),
  });

  const verifyDeps: VerifyDeps = {
    enabled: () => true,
    maxAttempts: 5,
    root,
    run: (touched, phase, attempt) => verifyOpts(phase, touched, attempt),
  };

  return {
    root,
    sessionId,
    pending,
    checkpoints,
    overlay: (base) => ({
      ...base,
      readFile: async (p) => {
        const e = pending.effective(norm(p));
        if (e === null) throw new Error("ENOENT: file is pending deletion");
        return e !== undefined ? e : base.readFile(p);
      },
    }),
    editTools: createEditTools(sink),
    verifyTools: createVerifyTools({
      runner: (phase, touched) => verifyOpts(phase, touched),
      touched: () => [...sessionTouched].map(([path, created]) => ({ path, created })),
    }),
    verifyDeps,
    hooks,
    gate,
    setRuntime: (rt) => {
      runtime = rt;
    },
    commands,
    runVerification: async (phase) => {
      const files = [...sessionTouched].map(([path, created]) => ({ path, created }));
      const report = await verifyOpts(phase, files);
      opts.onReport({ report, source: "manual", seq: ++seq });
      return report;
    },
    proposeCommandsSection: async () => {
      const existing = await diskFs.read(`${root}/AGENTS.md`);
      const detected = await (async () => {
        const c = await commands();
        return Object.keys(c).some((k) => k !== "sources" && c[k as keyof ProjectCommands]) ? c : null;
      })();
      if (!detected) return "nothing-detected";
      const next = withCommandsSection(existing, detected);
      if (next === null) return "exists";
      await pending.propose(`${root}/AGENTS.md`, next, "Record the detected build/test/lint commands so the agent runs the right checks", { requireReview: true });
      return "proposed";
    },
    hookErrors: parsedHooks.errors,
    plans,
    planGuard,
    planTools: createPlanTools({ store: plans, askUser: opts.askQuestions, onPlanWritten: opts.onPlanWritten }),
    rules,
    memories,
    docs,
    sessions,
    contextTools: createContextTools({ rules, docs, memories, autoMemories: () => loadSettings().autoMemories, onMemoryCreated: opts.onMemoryCreated }),
    facts,
    lintAll: async () => lintRules(await rules.load(), await facts()),
    proposeGeneratedRules: async () => {
      const draft = generateAgentsMd(await facts(), await commands(), root.split("/").pop());
      await pending.propose(`${root}/AGENTS.md`, draft, "Draft AGENTS.md generated from the detected stack, commands and conventions", { requireReview: true });
    },
  };
}
