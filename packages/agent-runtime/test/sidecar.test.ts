// The agent loop in a REAL separate OS process shared by every thread (bundled with esbuild, spawned with node),
// driven over stdio through the session multiplexer.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import type { AgentEvent, ModelGateway, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { READ_TOOLS, createToolHost, type FsBackend } from "@forge/tool-host";
import { RuntimeClient } from "../src/remote";
import { MuxClient, lineSplitter } from "../src/stdio";

const done: StreamEvent = { type: "done", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.1 } };
const text = (t: string): StreamEvent => ({ type: "text", delta: t });
const fs: FsBackend = { readFile: async (p) => `contents of ${p}`, readdir: async () => [] };
let bundle = "";
const procs: ChildProcessWithoutNullStreams[] = [];

const EXE = new URL("../../../apps/desktop/src-tauri/binaries/forge-runtime-x86_64-pc-windows-msvc.exe", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

beforeAll(async () => {
  bundle = join(mkdtempSync(join(tmpdir(), "forge-sidecar-")), "runtime.cjs");
  await build({ entryPoints: [new URL("../src/sidecar-main.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
}, 60_000);
afterAll(() => procs.forEach((p) => p.kill()));

/** Start one runtime process and the multiplexer in front of it, wired the way the app wires it. */
function launch(exe?: string) {
  const child = exe ? spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] }) : spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });
  procs.push(child);
  const mux = new MuxClient(
    (line) => void child.stdin.write(line + "\n"),
    (on) => child.stdout.on("data", lineSplitter(on)),
  );
  child.on("exit", () => mux.disconnected());
  return { child, mux };
}

let counter = 0;
function session(mux: MuxClient, gateway: ModelGateway) {
  return new RuntimeClient(mux.open(`t${++counter}`), { gateway, tools: createToolHost({ root: "/r", fs, tools: READ_TOOLS }) }, { provider: "p", model: "m" });
}
async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
/** A model that answers after a delay, and notices when its request is aborted. */
function slowModel(answer: string, ms: number) {
  const state = { aborted: false, started: false };
  const gateway: ModelGateway = {
    async *stream(req) {
      state.started = true;
      req.signal?.addEventListener("abort", () => (state.aborted = true));
      await new Promise((r) => setTimeout(r, ms));
      yield text(answer);
      yield done;
    },
  };
  return { gateway, state };
}

describe("one shared runtime process", () => {
  it("runs a full tool-using turn: the model and tools stay in the host, the loop is in another PID", async () => {
    const { child, mux } = launch();
    const gw = new ScriptedGateway([[{ type: "tool_call", call: { id: "1", name: "read_file", args: { path: "a.ts" } } }, done], [text("It reads a.ts."), done]]);
    const client = session(mux, gw);
    expect(child.pid).toBeGreaterThan(0);
    expect(child.pid).not.toBe(process.pid);
    const events = await drain(client.run({ mode: "ask", prompt: "what is a.ts?" }));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "done", "tool_result", "text", "done"]);
    expect(client.history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(client.costUsd).toBeCloseTo(0.2);
  }, 30_000);

  it("serves several threads at once through ONE process, each isolated, a slow one not holding up a fast one", async () => {
    const { mux } = launch();
    const slow = slowModel("slow answer", 600);
    const fast = new ScriptedGateway([[text("fast answer"), done]]);
    const a = session(mux, slow.gateway);
    const b = session(mux, fast);
    const finishedAt: Record<string, number> = {};
    const t0 = Date.now();
    const runA = drain(a.run({ mode: "ask", prompt: "question for A" })).then((e) => ((finishedAt.a = Date.now() - t0), e));
    await new Promise((r) => setTimeout(r, 100)); // A is mid-flight inside the shared process
    const runB = drain(b.run({ mode: "ask", prompt: "question for B" })).then((e) => ((finishedAt.b = Date.now() - t0), e));
    const [ea, eb] = await Promise.all([runA, runB]);
    expect(mux.size).toBe(2);
    expect(eb.some((e) => e.type === "text" && e.delta === "fast answer")).toBe(true);
    expect(ea.some((e) => e.type === "text" && e.delta === "slow answer")).toBe(true);
    expect(finishedAt.b!).toBeLessThan(finishedAt.a!); // B finished while A was still thinking
    // Their conversations never mixed.
    expect(JSON.stringify(a.history)).toContain("question for A");
    expect(JSON.stringify(a.history)).not.toContain("question for B");
    expect(JSON.stringify(b.history)).toContain("question for B");
    expect(JSON.stringify(b.history)).not.toContain("question for A");
  }, 30_000);

  it("closing one thread aborts only its own in-flight work", async () => {
    const { mux } = launch();
    const slow = slowModel("never shown", 3000);
    const other = new ScriptedGateway([[text("unaffected"), done]]);
    const a = session(mux, slow.gateway);
    const b = session(mux, other);
    const runA = drain(a.run({ mode: "ask", prompt: "long job" })).catch((e) => e as Error);
    await new Promise((r) => setTimeout(r, 200));
    expect(slow.state.started).toBe(true);
    a.terminate(); // the thread is closed while its model call is in flight
    const eb = await drain(b.run({ mode: "ask", prompt: "quick" }));
    expect(eb.some((e) => e.type === "text" && e.delta === "unaffected")).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(slow.state.aborted).toBe(true); // A's model request was cancelled
    expect(mux.size).toBe(1);
    void runA;
  }, 30_000);

  it("tells the owner when the last thread closes, so the process can be released", async () => {
    const { mux } = launch();
    let empties = 0;
    mux.onEmpty = () => empties++;
    const a = session(mux, new ScriptedGateway([]));
    const b = session(mux, new ScriptedGateway([]));
    a.terminate();
    expect(empties).toBe(0); // one thread still open
    b.terminate();
    expect(empties).toBe(1);
    expect(mux.size).toBe(0);
  }, 30_000);

  it("a crashed process fails every pending run immediately instead of hanging, and marks the sessions dead", async () => {
    const { child, mux } = launch();
    const slow = slowModel("never", 10_000);
    const a = session(mux, slow.gateway);
    const b = session(mux, slow.gateway);
    const runA = drain(a.run({ mode: "ask", prompt: "x" })).catch((e) => e as Error);
    const runB = drain(b.run({ mode: "ask", prompt: "y" })).catch((e) => e as Error);
    await new Promise((r) => setTimeout(r, 300));
    child.kill();
    const [ra, rb] = await Promise.all([runA, runB]);
    expect((ra as Error).message).toContain("exited unexpectedly");
    expect((rb as Error).message).toContain("exited unexpectedly");
    expect(a.isDead && b.isDead).toBe(true);
    expect(a.running).toBe(false);
  }, 30_000);

  it("a session that tries to start after the process died is dead on arrival, not stuck", async () => {
    const { child, mux } = launch();
    child.kill();
    await new Promise((r) => child.on("exit", r));
    const late = session(mux, new ScriptedGateway([]));
    mux.disconnected(); // what the app does when it notices the process is gone
    await expect(drain(late.run({ mode: "ask", prompt: "hi" }))).rejects.toThrow("exited unexpectedly");
  }, 30_000);

  it("ignores stray non-protocol output, and exits when the host closes its input", async () => {
    const { child, mux } = launch();
    const client = session(mux, new ScriptedGateway([[text("ok"), done]]));
    child.stdout.emit("data", Buffer.from("not json at all\n"));
    await drain(client.run({ mode: "ask", prompt: "x" }));
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    child.stdin.end();
    expect(await exited).toBe(0);
  }, 30_000);
});

describe.skipIf(!existsSync(EXE))("the packaged forge-runtime executable (no Node install needed)", () => {
  it("serves two threads through one process", async () => {
    const { mux } = launch(EXE);
    const make = (answer: string) => new ScriptedGateway([[{ type: "tool_call", call: { id: "1", name: "read_file", args: { path: "a.ts" } } }, done], [text(answer), done]]);
    const [ea, eb] = await Promise.all([drain(session(mux, make("one")).run({ mode: "ask", prompt: "read it" })), drain(session(mux, make("two")).run({ mode: "ask", prompt: "read it too" }))]);
    expect(ea.map((e) => e.type)).toEqual(["tool_call", "done", "tool_result", "text", "done"]);
    expect(eb.map((e) => e.type)).toEqual(["tool_call", "done", "tool_result", "text", "done"]);
  }, 60_000);
});
