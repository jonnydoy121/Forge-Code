import { spawn, type ChildProcess } from "node:child_process";
import type { LineTransport } from "./index";

export interface SpawnedTransport extends LineTransport {
  proc: ChildProcess;
  stderr: string[];
}

/** Spawn a child process speaking newline-delimited JSON on stdio (Node hosts and tests). */
export function spawnTransport(command: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): SpawnedTransport {
  const common = { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true };
  // Node refuses to spawn .cmd/.bat shims (npx, gemini, ...) directly on Windows (EINVAL): run them through cmd.exe.
  const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const quote = (a: string) => (a === "" || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const proc = shim
    ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(quote).join(" ")}"`], { ...common, windowsVerbatimArguments: true })
    : spawn(command, args, common);
  const stderr: string[] = [];
  let lineHandler: (l: string) => void = () => {};
  let closeHandler: () => void = () => {};
  let buf = "";
  proc.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) lineHandler(line);
    }
  });
  proc.stderr!.on("data", (d: Buffer) => stderr.push(d.toString("utf8")));
  proc.on("close", () => closeHandler());
  proc.on("error", (e) => {
    stderr.push(String(e));
    closeHandler();
  });
  return {
    proc,
    stderr,
    send: (line) => void proc.stdin!.write(line + "\n"),
    onLine: (h) => (lineHandler = h),
    onClose: (h) => (closeHandler = h),
    close: () => void proc.kill(),
  };
}
