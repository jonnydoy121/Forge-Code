import { FileCheckpointStore, type CheckpointFs } from "@forge/checkpoints";
import { PendingChanges, type ReviewMode } from "@forge/review";
import { createEditTools, type EditSink, type FsBackend, type RegisteredTool } from "@forge/tool-host";
import {
  HookRunner,
  createCommandTools,
  createVerifyTools,
  detectWeakening,
  loadCommands,
  parseHooksConfig,
  runChecks,
  withCommandsSection,
  type BackgroundRunner,
  type Exec,
  type ProjectCommands,
  type StructuredError,
  type VerificationReport,
} from "@forge/verify";
import { AuditLog, createPermissionGate, denyReason, guardFetch, type AskRequest, type Remember } from "@forge/safety";
import { McpManager, parseMcpConfig, type McpLauncher, type McpServerConfig, type McpServerStatus } from "@forge/mcp";
import { AcpClient, forgeAcpHandlers, parseAcpConfig, type AcpAgentConfig, type AcpUpdate } from "@forge/acp";
import type { LineTransport } from "@forge/rpc";
import { listen } from "@tauri-apps/api/event";
import { PlanGuard, PlanStore, createPlanTools, type Question } from "@forge/plans";
import { DocsStore, MemoryStore, RuleEngine, SessionStore, collectFacts, createContextTools, generateAgentsMd, lintRules, type LintWarning, type ProjectFacts, loadPrompts, loadSkills, createSkillTools, type SavedPrompt, type Skill } from "@forge/context-store";
import { loadSettings } from "./settings";
import { createDiagnosticsTool, type CheckResult } from "./diagnosticsTool";
import { CLAUDE_AGENT } from "./claudePlan";
import { fetchText as rawFetchText, pickFetch } from "./http";
import type { VerifyDeps } from "@forge/agent-runtime";
import type { AgentRuntime } from "@forge/agent-runtime/src/remote";
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
    if (o.sandbox) {
      const r = await invoke<{ code: number | null; stdout: string; stderr: string; timed_out: boolean; millis: number; mode: "appcontainer" | "env-only"; granted: string[]; warnings: string[] }>("sandbox_run", {
        cwd: o.cwd,
        command,
        timeoutMs: o.timeoutMs,
        toolchainRead: o.toolchainRead ?? true,
      });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timed_out, millis: r.millis, sandbox: { mode: r.mode, granted: r.granted, warnings: r.warnings } };
    }
    const r = await invoke<{ code: number | null; stdout: string; stderr: string; timed_out: boolean; millis: number }>("run_command", {
      cwd: o.cwd,
      command,
      timeoutMs: o.timeoutMs,
      env: Object.entries(o.env ?? {}),
    });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timed_out, millis: r.millis };
  },
};

export const tauriBg: BackgroundRunner = {
  start: (command, cwd) => invoke<number>("bg_start", { cwd, command }),
  read: async (id, lines) => {
    const r = await invoke<{ running: boolean; exit_code: number | null; output: string }>("bg_read", { id, lines });
    return { running: r.running, exitCode: r.exit_code, output: r.output };
  },
  stop: (id) => invoke<void>("bg_stop", { id }),
  list: () => invoke<{ id: number; command: string; running: boolean }[]>("bg_list"),
};

/** MCP servers and ACP agents are line-oriented subprocesses: bridge them through the Rust process manager. */
export async function launchLineProcess(command: string, args: string[], cwd: string | undefined, env: Record<string, string>): Promise<LineTransport & { id: number }> {
  let onLine: (l: string) => void = () => {};
  let onClose: () => void = () => {};
  const unlisten: (() => void)[] = [];
  const id = await invoke<number>("proc_start", { command, args, cwd, env: Object.entries(env) });
  unlisten.push(await listen<{ id: number; line: string }>("proc-line", (e) => e.payload.id === id && onLine(e.payload.line)));
  unlisten.push(await listen<{ id: number }>("proc-exit", (e) => e.payload.id === id && onClose()));
  return {
    id,
    send: (line) => void invoke("proc_send", { id, line }).catch(() => onClose()),
    onLine: (h) => (onLine = h),
    onClose: (h) => (onClose = h),
    close: () => {
      unlisten.forEach((u) => u());
      void invoke("proc_stop", { id });
    },
  };
}

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
  setRuntime(rt: AgentRuntime | null): void;
  /** parallel threads: count of runs in flight (accepting changes mid-run must not trigger the post-accept verification) */
  runBegin(): void;
  runEnd(): void;
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
  /** reusable slash-command prompts from .forge/prompts/*.md */
  prompts(): Promise<SavedPrompt[]>;
  /** skills from .forge/skills/<name>/SKILL.md */
  skills(): Promise<Skill[]>;
  /** use_skill, and run_skill_script (execute-class: gated, and sandboxed when sandboxing is on) */
  skillTools(settings: { sandbox: boolean; toolchainRead: boolean }): RegisteredTool[];
  docs: DocsStore;
  sessions: SessionStore;
  contextTools: RegisteredTool[];
  /** The `diagnostics` tool, or none when this workspace has no language server to ask. */
  diagnosticsTools: RegisteredTool[];
  /** Detected project facts (stack, config, code conventions) for linting and rule generation. */
  facts(): Promise<ProjectFacts>;
  /** Rules that contradict the project's own configuration, or contain secrets. */
  lintAll(): Promise<LintWarning[]>;
  /** Draft an AGENTS.md from the repo and propose it as a reviewable change. */
  proposeGeneratedRules(): Promise<void>;
  /** Every tool call, command, file write and model request of this session (persisted, secrets redacted). */
  audit: AuditLog;
  /** fetch for models, docs and web pages: logged, and refuses non-local hosts in local-only mode */
  fetch: ReturnType<typeof guardFetch>;
  commandTools(settings: { sandbox: boolean; toolchainRead: boolean }): RegisteredTool[];
  mcp: { configured: McpServerConfig[]; status(): McpServerStatus[]; connect(): Promise<RegisteredTool[]>; disconnect(): void; tools(): RegisteredTool[]; errors: string[] };
  acp: {
    /** The agents from .forge/acp.json, plus Claude (your Claude plan) when it has been switched on and the file does not define its own. */
    readonly agents: AcpAgentConfig[];
    /** Offer the built-in Claude agent (Claude Code, signed in with the developer's own Claude account). */
    useBuiltinClaude(on: boolean): void;
    errors: string[];
    /** Run one prompt through an external agent; its file edits land in the review UI. */
    prompt(agent: string, text: string, onUpdate: (u: AcpUpdate) => void, signal?: AbortSignal): Promise<{ stopReason: string }>;
    stop(agent: string): void;
  };
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
  /** Where runtime state (pending changes, checkpoints, audit, sessions, docs, permissions) lives. Defaults to <root>/.forge.
   *  Isolated threads keep it outside their worktree so none of it is ever committed to the thread's branch. */
  stateDir?: string;
  mode: () => ReviewMode;
  planFiles?: () => string[] | null;
  onChange: () => void;
  onReport: (e: ReportEvent) => void;
  onHook: (event: string, output: string) => void;
  /** Ask the developer to approve an execute/network tool call. */
  ask: (req: AskRequest) => Promise<Remember>;
  /** Current LSP diagnostics for workspace-relative files. */
  diagnostics: (files: string[]) => Promise<StructuredError[]>;
  /** Ask the language server about a file's text (workspace-relative path). Absent when there is no language server to ask. */
  checkFile?: (rel: string, text: string) => Promise<CheckResult>;
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
  const stateDir = norm(opts.stateDir ?? `${root}/.forge`).replace(/\/+$/, "");
  const checkpoints = new FileCheckpointStore({ fs: diskFs, dir: `${stateDir}/checkpoints/${sessionId}` });
  const rel = (p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  let runtime: AgentRuntime | null = null;
  let activeRuns = 0;
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

  const auditRef: { current: AuditLog | null } = { current: null };
  // Pending changes survive restarts: saved (debounced) to .forge/pending and restored below.
  const pendingFile = `${stateDir}/pending/${sessionId}.json`;
  let restored = false;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePersist = () => {
    if (!restored) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => void diskFs.write(pendingFile, JSON.stringify(pending.exportState())).catch(() => {}), 200);
  };
  let verifyTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new PendingChanges({
    fs: diskFs,
    checkpoints,
    mode: opts.mode,
    planFiles: opts.planFiles,
    historyLength: () => runtime?.history.length ?? 0,
    guard: (path, base, proposed) => detectWeakening(rel(path), base, proposed),
    onChange: () => {
      opts.onChange();
      schedulePersist();
    },
    onApplied: async (path, origin) => {
      const r = rel(path);
      auditRef.current?.record({ kind: "file", name: `write ${r}`, detail: origin === "agent-auto" ? "applied automatically (checkpointed)" : "accepted by the developer" });
      sessionTouched.set(r, sessionTouched.get(r) ?? false);
      if (origin === "developer") touchedAfterAccept.add(r);
      const out = await hooks.run("PostEdit", { files: [r] });
      if (out.ran) opts.onHook("PostEdit", out.output);
      // Edits accepted by the developer: once nothing is left to review, verify what landed.
      clearTimeout(verifyTimer);
      verifyTimer = setTimeout(() => {
        if (pending.list().length === 0 && touchedAfterAccept.size > 0 && activeRuns === 0) {
          const files = [...touchedAfterAccept].map((path) => ({ path, created: false }));
          touchedAfterAccept.clear();
          void verifyOpts("full", files).then((report) => opts.onReport({ report, source: "accepted-changes", seq: ++seq }));
        }
      }, 400);
    },
  });

  let fetchTextLate: (u: string) => Promise<string> = rawFetchText;
  const home = await invoke<string | null>("home_dir").catch(() => null);
  const rules = new RuleEngine(diskFs, root, () => loadSettings().userRules);
  const memories = new MemoryStore(diskFs, { project: `${root}/.forge/memory`, user: home ? `${norm(home)}/.forge/memory` : undefined }, opts.onChange);
  const docs = new DocsStore(diskFs, `${stateDir}/docs`, (u) => fetchTextLate(u), opts.onChange);
  const sessions = new SessionStore(diskFs, `${stateDir}/sessions`);
  const uniqueFiles = async (pattern: string, glob?: string) => new Set((await indexBackend.grep(pattern, glob, 5000).catch(() => [])).map((h) => h.file)).size;
  const facts = async () =>
    collectFacts(diskFs, root, {
      defaultExportFiles: await uniqueFiles("^export default"),
      namedExportFiles: await uniqueFiles("^export (const|function|class|type|interface|enum) "),
      testNaming: { test: await uniqueFiles("\\b(describe|test|it)\\(", "**/*.test.*"), spec: await uniqueFiles("\\b(describe|test|it)\\(", "**/*.spec.*") },
    });

  const plans = new PlanStore(diskFs, root, opts.onChange);
  const planGuard = new PlanGuard({ store: plans, askAddFile: opts.askAddFile, onBlocked: opts.onBlocked }, root);

  const audit = new AuditLog(diskFs, `${stateDir}/audit/${sessionId}.jsonl`);
  void audit.load();
  const guarded = guardFetch(
    async (url, init) => (await pickFetch())(url, init),
    { localOnly: () => loadSettings().localOnly, audit },
  );
  const fetchText = async (url: string) => {
    const r = await guarded(url, { method: "GET", headers: { accept: "text/html,text/plain,text/markdown" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
    return (await r.text()).slice(0, 2_000_000);
  };
  fetchTextLate = fetchText;
  auditRef.current = audit;

  try {
    const saved = await diskFs.read(pendingFile);
    if (saved) pending.importState(JSON.parse(saved));
  } catch {
    /* a corrupt snapshot is ignored: pending changes are a convenience, never a source of truth */
  }
  restored = true;

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
    audit: (e) => audit.record({ kind: "permission", name: e.tool, detail: `${e.decision}${e.danger ? " (dangerous: " + e.danger + ")" : ""}: ${e.summary}`, blocked: e.decision === "deny" }),
    load: async () => {
      try {
        const t = await diskFs.read(`${stateDir}/permissions.json`);
        return t ? (JSON.parse(t) as { allow: { tool: string; pattern: string }[] }) : { allow: [] };
      } catch {
        return { allow: [] };
      }
    },
    save: (f) => diskFs.write(`${stateDir}/permissions.json`, JSON.stringify(f, null, 2)),
  });

  const verifyDeps: VerifyDeps = {
    enabled: () => true,
    maxAttempts: 5,
    root,
    run: (touched, phase, attempt) => verifyOpts(phase, touched, attempt),
  };

  const mcpCfg = parseMcpConfig(await diskFs.read(`${root}/.forge/mcp.json`));
  let mcpTools: RegisteredTool[] = [];
  const mcpLauncher: McpLauncher = { launch: async (cfg) => launchLineProcess(cfg.command, cfg.args, root, cfg.env) };
  const mcpManager = new McpManager(mcpLauncher);
  const mcpHandle = {
    configured: mcpCfg.servers,
    errors: mcpCfg.errors,
    status: () => mcpManager.status,
    tools: () => mcpTools,
    connect: async () => {
      // Starting an external process is an execute-class action: the developer approves each server.
      const approved: McpServerConfig[] = [];
      for (const c of mcpCfg.servers) {
        const summary = `Start MCP server "${c.name}": ${[c.command, ...c.args].join(" ")}`;
        const a = await opts.ask({ tool: "mcp-server", cls: "execute", summary });
        audit.record({ kind: "external", name: `mcp start ${c.name}`, detail: a, blocked: a === "deny" });
        if (a !== "deny") approved.push(c);
      }
      mcpManager.close();
      mcpTools = await mcpManager.start(approved);
      return mcpTools;
    },
    disconnect: () => {
      mcpManager.close();
      mcpTools = [];
    },
  };

  const acpCfg = parseAcpConfig(await diskFs.read(`${root}/.forge/acp.json`));
  const acpClients = new Map<string, { client: AcpClient; session: string; close: () => void; onUpdate: { current: (u: AcpUpdate) => void } }>();
  let builtinClaude = false;
  const allAgents = () => (builtinClaude && !acpCfg.agents.some((a) => a.name === CLAUDE_AGENT.name) ? [...acpCfg.agents, CLAUDE_AGENT] : acpCfg.agents);
  const acpHandle = {
    get agents() {
      return allAgents();
    },
    useBuiltinClaude: (on: boolean) => {
      builtinClaude = on;
    },
    errors: acpCfg.errors,
    prompt: async (name: string, text: string, onUpdate: (u: AcpUpdate) => void, signal?: AbortSignal) => {
      const cfg = allAgents().find((a) => a.name === name);
      if (!cfg) throw new Error(`no external agent named ${name}`);
      let entry = acpClients.get(name);
      if (!entry) {
        const a = await opts.ask({ tool: "external-agent", cls: "execute", summary: `Start external agent "${name}": ${[cfg.command, ...cfg.args].join(" ")}. Its file edits will go through review; it can ask to run commands.` });
        audit.record({ kind: "external", name: `acp start ${name}`, detail: a, blocked: a === "deny" });
        if (a === "deny") throw new Error("You declined to start the external agent.");
        const transport = await launchLineProcess(cfg.command, cfg.args, root, cfg.env);
        const updateRef = { current: onUpdate };
        const client = new AcpClient(
          transport,
          forgeAcpHandlers({
            root,
            agentName: name,
            read: async (p) => {
              const e = pending.effective(p);
              return e !== undefined ? e : diskFs.read(p);
            },
            propose: async (path, content, reason) => {
              const o = await pending.propose(path, content, reason);
              return { status: o.status };
            },
            ask: (r) => opts.ask({ tool: "external-agent", cls: "execute", summary: r.summary, danger: r.danger }),
            denyReason,
            onUpdate: (u) => updateRef.current(u),
            audit: (e) => audit.record({ kind: "external", name: e.name, detail: e.detail, blocked: e.blocked }),
          }),
        );
        await client.initialize();
        const session = await client.newSession(root);
        entry = { client, session, close: () => transport.close(), onUpdate: updateRef };
        acpClients.set(name, entry);
      }
      entry.onUpdate.current = onUpdate;
      const onAbort = () => entry!.client.cancel(entry!.session);
      signal?.addEventListener("abort", onAbort);
      try {
        return await entry.client.prompt(entry.session, text);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    stop: (name: string) => {
      acpClients.get(name)?.close();
      acpClients.delete(name);
    },
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
    diagnosticsTools: opts.checkFile ? [createDiagnosticsTool(opts.checkFile)] : [],
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
    runBegin: () => void activeRuns++,
    runEnd: () => void (activeRuns = Math.max(0, activeRuns - 1)),
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
    prompts: () => loadPrompts(diskFs, `${root}/.forge/prompts`),
    skills: () => loadSkills(diskFs, `${root}/.forge/skills`, home ? `${norm(home)}/.forge/skills` : undefined),
    skillTools: (st) =>
      createSkillTools({
        root,
        fs: diskFs,
        skills: () => loadSkills(diskFs, `${root}/.forge/skills`, home ? `${norm(home)}/.forge/skills` : undefined),
        exec: tauriExec,
        sandbox: () => st.sandbox,
        toolchainRead: () => st.toolchainRead,
        audit: (e) => audit.record({ kind: "command", name: e.name, detail: e.detail, blocked: e.blocked }),
      }),
    docs,
    sessions,
    contextTools: createContextTools({ rules, docs, memories, autoMemories: () => loadSettings().autoMemories, onMemoryCreated: opts.onMemoryCreated }),
    facts,
    audit,
    fetch: guarded,
    commandTools: (st) =>
      createCommandTools({
        exec: tauriExec,
        bg: tauriBg,
        cwd: root,
        sandbox: () => st.sandbox,
        toolchainRead: () => st.toolchainRead,
        audit: (e) => audit.record({ kind: e.kind, name: e.name, detail: e.detail, blocked: e.blocked }),
      }),
    mcp: mcpHandle,
    acp: acpHandle,
    lintAll: async () => lintRules(await rules.load(), await facts()),
    proposeGeneratedRules: async () => {
      const draft = generateAgentsMd(await facts(), await commands(), root.split("/").pop());
      await pending.propose(`${root}/AGENTS.md`, draft, "Draft AGENTS.md generated from the detected stack, commands and conventions", { requireReview: true });
    },
  };
}
