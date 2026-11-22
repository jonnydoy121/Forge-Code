import { spawn } from "node:child_process";
import type { Exec, ExecResult } from "./exec";

/** Exec over Node child_process (tests and Node-hosted workers). */
export const nodeExec: Exec = {
  run(command, opts) {
    return new Promise<ExecResult>((resolve) => {
      const started = Date.now();
      const child = spawn(command, { cwd: opts.cwd, shell: true, env: { ...process.env, ...opts.env }, windowsHide: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const cap = (s: string) => (s.length > 2_000_000 ? s.slice(0, 2_000_000) : s);
      child.stdout.on("data", (d) => (stdout = cap(stdout + d)));
      child.stderr.on("data", (d) => (stderr = cap(stderr + d)));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut, millis: Date.now() - started });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: stderr + String(e), timedOut, millis: Date.now() - started });
      });
    });
  },
};
