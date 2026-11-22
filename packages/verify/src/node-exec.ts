import { spawn, spawnSync } from "node:child_process";
import { scrubEnv } from "@forge/safety";
import type { Exec, ExecResult } from "./exec";

/** Kill the command and everything it started. Killing only the shell would leave its children holding the pipes open. */
function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL"); // detached => its own process group
  } catch {
    /* already gone */
  }
}

/** Exec over Node child_process (tests and Node-hosted workers). */
export const nodeExec: Exec = {
  run(command, opts) {
    return new Promise<ExecResult>((resolve) => {
      const started = Date.now();
      const child = spawn(command, { cwd: opts.cwd, shell: true, detached: process.platform !== "win32", env: { ...(opts.sandbox ? scrubEnv(process.env) : process.env), ...opts.env }, windowsHide: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const cap = (s: string) => (s.length > 2_000_000 ? s.slice(0, 2_000_000) : s);
      child.stdout.on("data", (d) => (stdout = cap(stdout + d)));
      child.stderr.on("data", (d) => (stderr = cap(stderr + d)));
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
        child.kill();
      }, opts.timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut, millis: Date.now() - started, sandbox: opts.sandbox ? { mode: "env-only" } : undefined });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: stderr + String(e), timedOut, millis: Date.now() - started });
      });
    });
  },
};
