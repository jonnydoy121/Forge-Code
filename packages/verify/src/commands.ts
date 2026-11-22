import { sensitivePathReason } from "@forge/safety";
import type { RegisteredTool } from "@forge/tool-host";
import type { Exec, ExecResult } from "./exec";
import { stripAnsi } from "./parsers";

export interface BackgroundRunner {
  start(command: string, cwd: string): Promise<number>;
  read(id: number, lines: number): Promise<{ running: boolean; exitCode: number | null; output: string }>;
  stop(id: number): Promise<void>;
  list(): Promise<{ id: number; command: string; running: boolean }[]>;
}

export interface CommandToolDeps {
  exec: Exec;
  bg?: BackgroundRunner;
  cwd: string;
  /** Run commands inside the OS sandbox (default true). */
  sandbox?: () => boolean;
  toolchainRead?: () => boolean;
  /** Audit hook for every command and its outcome. */
  audit?: (e: { kind: "command" | "sandbox"; name: string; detail?: string; blocked?: boolean }) => void;
}

const MAX_CMD = 2000;
const tailOf = (s: string, n: number) => (s.length > n ? `[... ${s.length - n} earlier characters omitted]\n${s.slice(-n)}` : s);

export function formatCommandResult(r: ExecResult): string {
  const out = stripAnsi(r.stdout).trim();
  const err = stripAnsi(r.stderr).trim();
  const lines = [r.timedOut ? "The command timed out and was killed." : `exit code ${r.code}`];
  if (r.sandbox) lines.push(r.sandbox.mode === "appcontainer" ? "(ran in the OS sandbox: workspace only, no network)" : r.sandbox.mode === "env-only" ? "(ran with a scrubbed environment; this platform has no OS sandbox)" : "");
  if (out) lines.push("--- stdout ---", tailOf(out, 6000));
  if (err) lines.push("--- stderr ---", tailOf(err, 3000));
  for (const w of r.sandbox?.warnings ?? []) lines.push(`note: ${w}`);
  return lines.filter(Boolean).join("\n");
}

/**
 * run_command and background-process tools. Execute-class, so the permission gate (with its deny list) decides first.
 * Commands are also refused when they reach for credential stores, and run in the sandbox unless the developer
 * turned it off.
 */
export function createCommandTools(d: CommandToolDeps): RegisteredTool[] {
  const refuse = (command: string): string | null => {
    const why = sensitivePathReason(command);
    if (why) d.audit?.({ kind: "command", name: command, detail: `refused: ${why}`, blocked: true });
    return why;
  };
  const tools: RegisteredTool[] = [
    {
      spec: {
        name: "run_command",
        description:
          "Run a shell command in the workspace and return its output. It runs in an OS sandbox with no network and no access to credentials or files outside the workspace. Use it for builds, tests, git status/diff, and inspecting the project. The developer approves commands, and destructive or outward-facing ones always ask.",
        parameters: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["command"] },
        class: "execute",
      },
      async run(args) {
        const command = typeof args.command === "string" ? args.command.trim() : "";
        if (!command) throw new Error("missing required argument: command");
        if (command.length > MAX_CMD) throw new Error(`command is too long (max ${MAX_CMD} characters)`);
        const why = refuse(command);
        if (why) throw new Error(`refused: this command touches ${why}. Agent commands cannot read credentials or secrets.`);
        const timeoutMs = Math.min(600, Math.max(1, typeof args.timeout_seconds === "number" ? args.timeout_seconds : 120)) * 1000;
        const sandbox = d.sandbox?.() ?? true;
        d.audit?.({ kind: "command", name: command, detail: sandbox ? "sandboxed" : "NOT sandboxed" });
        const r = await d.exec.run(command, { cwd: d.cwd, timeoutMs, sandbox, toolchainRead: d.toolchainRead?.() ?? true });
        d.audit?.({ kind: "command", name: command, detail: r.timedOut ? "timed out" : `exit ${r.code}${r.sandbox ? ` (${r.sandbox.mode})` : ""}` });
        for (const g of r.sandbox?.granted ?? []) d.audit?.({ kind: "sandbox", name: `granted read access to ${g}` });
        return formatCommandResult(r);
      },
    },
  ];
  if (d.bg) {
    const bg = d.bg;
    tools.push(
      {
        spec: {
          name: "bg_start",
          description: "Start a long-running command (a dev server or watcher) in the background and return its id. It runs WITHOUT the network sandbox because servers must listen on a port, so the developer is always asked. Read its output with bg_read; stop it with bg_stop.",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          class: "execute",
        },
        async run(args) {
          const command = typeof args.command === "string" ? args.command.trim() : "";
          if (!command) throw new Error("missing required argument: command");
          const why = refuse(command);
          if (why) throw new Error(`refused: this command touches ${why}.`);
          d.audit?.({ kind: "command", name: command, detail: "background, no network sandbox" });
          const id = await bg.start(command, d.cwd);
          return `Started background process ${id}. Use bg_read to see its output and bg_stop to stop it.`;
        },
      },
      {
        spec: {
          name: "bg_read",
          description: "Read the most recent output lines of a background process started with bg_start, and whether it is still running.",
          parameters: { type: "object", properties: { id: { type: "number" }, lines: { type: "number" } }, required: ["id"] },
          class: "read",
        },
        async run(args) {
          const r = await bg.read(Number(args.id), Math.min(500, Number(args.lines) || 80));
          return `${r.running ? "running" : `exited with code ${r.exitCode}`}\n${tailOf(stripAnsi(r.output), 6000) || "(no output yet)"}`;
        },
      },
      {
        spec: { name: "bg_stop", description: "Stop a background process you started.", parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] }, class: "read" },
        async run(args) {
          await bg.stop(Number(args.id));
          return `Stopped background process ${args.id}.`;
        },
      },
      {
        spec: { name: "bg_list", description: "List background processes started in this session.", parameters: { type: "object", properties: {} }, class: "read" },
        async run() {
          const l = await bg.list();
          return l.length ? l.map((p) => `${p.id}: ${p.running ? "running" : "exited"}  ${p.command}`).join("\n") : "no background processes";
        },
      },
    );
  }
  return tools;
}
