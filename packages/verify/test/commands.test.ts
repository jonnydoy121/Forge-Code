import { describe, expect, it } from "vitest";
import { createToolHost, type FsBackend } from "@forge/tool-host";
import { createCommandTools, formatCommandResult, type BackgroundRunner, type Exec } from "../src";
import { nodeExec } from "../src/node-exec";

const nofs: FsBackend = { readFile: async () => "", readdir: async () => [] };

function setup(opts: { exec?: Exec; sandbox?: boolean } = {}) {
  const audit: { kind: string; name: string; detail?: string; blocked?: boolean }[] = [];
  const procs = new Map<number, { command: string; lines: string[]; running: boolean }>();
  let next = 0;
  const bg: BackgroundRunner = {
    start: async (command) => (procs.set(++next, { command, lines: ["listening on :3000"], running: true }), next),
    read: async (id) => {
      const p = procs.get(id);
      if (!p) throw new Error(`no background process ${id}`);
      return { running: p.running, exitCode: p.running ? null : 0, output: p.lines.join("\n") };
    },
    stop: async (id) => void (procs.get(id)!.running = false),
    list: async () => [...procs].map(([id, p]) => ({ id, command: p.command, running: p.running })),
  };
  const host = createToolHost({ root: "/r", fs: nofs, tools: createCommandTools({ exec: opts.exec ?? nodeExec, bg, cwd: process.cwd(), sandbox: () => opts.sandbox ?? true, audit: (e) => audit.push(e) }) });
  return { host, audit, call: (name: string, args: Record<string, unknown>, mode: "ask" | "agent" = "agent") => host.call(mode, { id: "1", name, args }) };
}

describe("command tools", () => {
  it("are execute-class: absent in ask and plan mode", () => {
    const { host } = setup();
    expect(host.listTools("ask").map((t) => t.name)).toEqual(["bg_read", "bg_stop", "bg_list"]); // read-class helpers only operate on processes started earlier
    expect(host.listTools("plan").map((t) => t.name)).not.toContain("run_command");
    expect(host.listTools("agent").map((t) => t.name)).toEqual(expect.arrayContaining(["run_command", "bg_start"]));
  });

  it("runs a command, returns exit code and output, and audits it", async () => {
    const { call, audit } = setup();
    const r = await call("run_command", { command: "node -e \"console.log('hello-from-cmd'); console.error('warn-line'); process.exit(3)\"" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("exit code 3");
    expect(r.output).toContain("--- stdout ---\nhello-from-cmd");
    expect(r.output).toContain("--- stderr ---\nwarn-line");
    expect(audit.map((a) => a.kind)).toEqual(["command", "command"]);
    expect(audit[0]!.detail).toBe("sandboxed");
  });

  it("scrubs secrets from the environment when sandboxed, and not otherwise", async () => {
    process.env.FORGE_UNIT_API_TOKEN = "super-secret-value";
    try {
      const cmd = "node -e \"console.log('TOKEN=' + (process.env.FORGE_UNIT_API_TOKEN || 'absent'))\"";
      expect((await setup({ sandbox: true }).call("run_command", { command: cmd })).output).toContain("TOKEN=absent");
      expect((await setup({ sandbox: false }).call("run_command", { command: cmd })).output).toContain("TOKEN=super-secret-value");
    } finally {
      delete process.env.FORGE_UNIT_API_TOKEN;
    }
  });

  it("refuses commands that reach for credential stores, without running them", async () => {
    let ran = false;
    const { call, audit } = setup({ exec: { run: async () => ((ran = true), { code: 0, stdout: "", stderr: "", timedOut: false, millis: 1 }) } });
    for (const command of ["cat ~/.ssh/id_rsa", "type %USERPROFILE%\\.aws\\credentials", "env | grep KEY"]) {
      const r = await call("run_command", { command });
      expect(r.ok, command).toBe(false);
      expect(r.output).toContain("refused");
    }
    expect(ran).toBe(false);
    expect(audit.filter((a) => a.blocked)).toHaveLength(3);
  });

  it("validates arguments and clamps the timeout", async () => {
    const seen: number[] = [];
    const { call } = setup({ exec: { run: async (_c, o) => (seen.push(o.timeoutMs), { code: 0, stdout: "ok", stderr: "", timedOut: false, millis: 1 }) } });
    expect((await call("run_command", {})).ok).toBe(false);
    expect((await call("run_command", { command: "x".repeat(2001) })).output).toContain("too long");
    await call("run_command", { command: "echo", timeout_seconds: 99999 });
    await call("run_command", { command: "echo", timeout_seconds: -5 });
    expect(seen).toEqual([600_000, 1000]);
  });

  it("reports timeouts and the sandbox mode honestly", () => {
    expect(formatCommandResult({ code: null, stdout: "", stderr: "", timedOut: true, millis: 1 })).toContain("timed out");
    expect(formatCommandResult({ code: 0, stdout: "x", stderr: "", timedOut: false, millis: 1, sandbox: { mode: "appcontainer" } })).toContain("no network");
    const noOs = formatCommandResult({ code: 0, stdout: "", stderr: "", timedOut: false, millis: 1, sandbox: { mode: "env-only", warnings: ["no OS sandbox on this platform"] } });
    expect(noOs).toContain("scrubbed environment");
    expect(noOs).toContain("note: no OS sandbox");
  });

  it("background processes: start, read, list, stop", async () => {
    const { call } = setup();
    expect((await call("bg_start", { command: "npm run dev" })).output).toContain("Started background process 1");
    expect((await call("bg_read", { id: 1 })).output).toBe("running\nlistening on :3000");
    expect((await call("bg_list", {})).output).toBe("1: running  npm run dev");
    await call("bg_stop", { id: 1 });
    expect((await call("bg_read", { id: 1 })).output).toContain("exited with code 0");
    expect((await call("bg_read", { id: 99 })).ok).toBe(false);
    expect((await call("bg_start", { command: "cat ~/.ssh/id_rsa" })).ok).toBe(false);
  });
});
