import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { nodeExec } from "../src/node-exec";

describe("nodeExec", () => {
  it("returns output and the exit code", async () => {
    const r = await nodeExec.run("node --version", { cwd: tmpdir(), timeoutMs: 20_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/v\d+\./);
  });

  it("kills a command that exceeds its timeout promptly, including what it started", async () => {
    // A shell that starts a long-running child: killing only the shell would keep the pipes open for the full 30 s.
    const sleeper = process.platform === "win32" ? "ping -n 30 127.0.0.1 > nul" : "sleep 30; echo unreachable";
    const r = await nodeExec.run(sleeper, { cwd: tmpdir(), timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(r.millis).toBeLessThan(5000);
  }, 15_000);
});
