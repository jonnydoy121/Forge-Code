// The agent loop in a REAL separate OS process (bundled with esbuild, spawned with node), driven over stdio.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import type { AgentEvent, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { READ_TOOLS, createToolHost, type FsBackend } from "@forge/tool-host";
import { RuntimeClient } from "../src/remote";
import { linePort, lineSplitter } from "../src/stdio";

const done: StreamEvent = { type: "done", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.1 } };
const fs: FsBackend = { readFile: async (p) => `contents of ${p}`, readdir: async () => [] };
let bundle = "";
const procs: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  bundle = join(mkdtempSync(join(tmpdir(), "forge-sidecar-")), "runtime.cjs");
  await build({ entryPoints: [new URL("../src/sidecar-main.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
}, 60_000);
afterAll(() => procs.forEach((p) => p.kill()));

const EXE = new URL("../../../apps/desktop/src-tauri/binaries/forge-runtime-x86_64-pc-windows-msvc.exe", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function connect(gateway: ScriptedGateway, exe?: string) {
  const child = exe ? spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] }) : spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });
  procs.push(child);
  const port = linePort(
    (line) => void child.stdin.write(line + "\n"),
    (on) => child.stdout.on("data", lineSplitter(on)),
  );
  const tools = createToolHost({ root: "/r", fs, tools: READ_TOOLS });
  return { child, client: new RuntimeClient(port, { gateway, tools }, { provider: "p", model: "m" }) };
}
async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("runtime in a separate OS process", () => {
  it("runs a full tool-using turn: the model and tools stay in the host, the loop is in another PID", async () => {
    const gw = new ScriptedGateway([[{ type: "tool_call", call: { id: "1", name: "read_file", args: { path: "a.ts" } } }, done], [{ type: "text", delta: "It reads a.ts." }, done]]);
    const { child, client } = connect(gw);
    expect(child.pid).toBeGreaterThan(0);
    expect(child.pid).not.toBe(process.pid);
    const events = await drain(client.run({ mode: "ask", prompt: "what is a.ts?" }));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "done", "tool_result", "text", "done"]);
    expect(client.history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(client.costUsd).toBeCloseTo(0.2);
  }, 30_000);

  it("exits when the host goes away, and ignores stray non-protocol output", async () => {
    const { child, client } = connect(new ScriptedGateway([[{ type: "text", delta: "ok" }, done]]));
    child.stdout.emit("data", Buffer.from("not json at all\n"));
    await drain(client.run({ mode: "ask", prompt: "x" }));
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    child.stdin.end();
    expect(await exited).toBe(0);
  }, 30_000);
});

describe.skipIf(!existsSync(EXE))("the packaged forge-runtime executable (no Node install needed)", () => {
  it("serves a full turn", async () => {
    const gw = new ScriptedGateway([[{ type: "tool_call", call: { id: "1", name: "read_file", args: { path: "a.ts" } } }, done], [{ type: "text", delta: "done" }, done]]);
    const { client } = connect(gw, EXE);
    const events = await drain(client.run({ mode: "ask", prompt: "read it" }));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "done", "tool_result", "text", "done"]);
  }, 60_000);
});
