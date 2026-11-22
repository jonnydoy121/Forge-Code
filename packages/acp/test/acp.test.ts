import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { spawnTransport } from "@forge/rpc/src/node";
import { denyReason } from "@forge/safety";
import { AcpClient, forgeAcpHandlers, parseAcpConfig, type AcpUpdate, type ForgeAcpDeps } from "../src";

const AGENT = resolve(__dirname, "fixtures/mock-acp-agent.mjs");
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

/** Forge's side backed by an in-memory "workspace" and a recorder for pending proposals. */
function harness(answer: "once" | "session" | "always" | "deny" = "once") {
  const disk = new Map<string, string>([
    ["/ws/greet.js", "export const greet = (n) => n;\nconst x = 1;\n"],
    ["/ws/.env", "TOKEN=hunter2"],
    ["/outside/secret.txt", "nope"],
  ]);
  const proposals: { path: string; content: string; reason: string }[] = [];
  const updates: AcpUpdate[] = [];
  const asked: { title: string; summary: string; danger?: string }[] = [];
  const audit: { name: string; detail?: string; blocked?: boolean }[] = [];
  const deps: ForgeAcpDeps = {
    root: "/ws",
    read: async (p) => disk.get(p) ?? null,
    propose: async (path, content, reason) => (proposals.push({ path, content, reason }), { status: "pending" }),
    ask: async (r) => (asked.push(r), answer),
    onUpdate: (u) => updates.push(u),
    denyReason,
    agentName: "mock",
    audit: (e) => audit.push(e),
  };
  return { disk, proposals, updates, asked, audit, deps };
}

async function connect(h: ReturnType<typeof harness>) {
  const t = spawnTransport("node", [AGENT]);
  closers.push(() => t.close());
  const c = new AcpClient(t, forgeAcpHandlers(h.deps));
  await c.initialize();
  const session = await c.newSession("/ws");
  const run = (steps: object[]) => c.prompt(session, JSON.stringify(steps));
  return { c, session, run };
}
const messages = (u: AcpUpdate[]) => u.filter((x): x is Extract<AcpUpdate, { kind: "message" }> => x.kind === "message").map((x) => x.text);

describe("ACP client against a real agent subprocess", () => {
  it("handshakes, creates a session, and streams message, tool-call and plan updates", async () => {
    const h = harness();
    const { c, run } = await connect(h);
    expect(c.agentInfo).toEqual({ name: "mock-agent", version: "0.1" });
    const r = await run([{ say: "Looking around." }, { read: "greet.js" }]);
    expect(r.stopReason).toBe("end_turn");
    expect(messages(h.updates)).toEqual(["Looking around.", "READ-OK export const greet = (n) => n;"]);
    expect(h.updates.find((u) => u.kind === "tool_call")).toMatchObject({ title: "Read greet.js", toolKind: "read", status: "in_progress" });
    expect(h.updates.find((u) => u.kind === "tool_call_update")).toMatchObject({ status: "completed", text: expect.stringMatching(/^read \d+ chars$/) });
    expect(h.updates.at(-1)).toMatchObject({ kind: "plan", entries: [{ content: "finish", status: "completed" }] });
  });

  it("routes the agent's file WRITES into the pending-changes model, not onto disk (review UI)", async () => {
    const h = harness();
    const { run } = await connect(h);
    await run([{ replace: { path: "greet.js", from: "(n) => n", to: "(n) => `Hello, ${n}`" } }]);
    expect(messages(h.updates)).toContain("WRITE-OK");
    expect(h.proposals).toEqual([{ path: "/ws/greet.js", content: "export const greet = (n) => `Hello, ${n}`;\nconst x = 1;\n", reason: "Edit by mock" }]);
    expect(h.disk.get("/ws/greet.js")).toBe("export const greet = (n) => n;\nconst x = 1;\n"); // untouched until the developer accepts
  });

  it("agents see pending proposals through the same overlay as the built-in agent (read after write)", async () => {
    const h = harness();
    h.deps.read = async (p) => (h.proposals.find((x) => x.path === p)?.content ?? h.disk.get(p) ?? null);
    const { run } = await connect(h);
    await run([{ write: { path: "new.js", content: "// new file\n" } }, { read: "new.js" }]);
    expect(messages(h.updates)).toEqual(["WRITE-OK", "READ-OK // new file"]);
  });

  it("confines the agent to the workspace and to non-secret files", async () => {
    const h = harness();
    const { run } = await connect(h);
    await run([{ read: "../outside/secret.txt" }, { read: ".env" }, { write: { path: ".env", content: "X=1" } }, { write: { path: "node_modules/x/index.js", content: "x" } }]);
    const m = messages(h.updates);
    expect(m[0]).toContain("READ-FAILED path escapes workspace");
    expect(m[1]).toContain("READ-FAILED refusing: this file looks like it holds secrets");
    expect(m[2]).toContain("WRITE-FAILED refusing");
    expect(m[3]).toContain("WRITE-FAILED refusing: writes to ignored or generated directories");
    expect(h.proposals).toEqual([]);
    expect(h.audit.filter((a) => a.blocked)).toHaveLength(4);
  });

  it("asks the developer for permission and honours allow and reject", async () => {
    const allow = harness("once");
    await (await connect(allow)).run([{ permission: "Run the tests", command: "npm test" }, { write: { path: "a.js", content: "1" } }]);
    expect(messages(allow.updates)).toEqual(["PERMISSION allow-once", "WRITE-OK"]);
    expect(allow.asked[0]).toEqual({ title: "mock: Run the tests", summary: "mock wants to run: npm test", danger: undefined });

    const reject = harness("deny");
    await (await connect(reject)).run([{ permission: "Run the tests", command: "npm test" }, { write: { path: "a.js", content: "1" } }]);
    expect(messages(reject.updates)).toEqual(["PERMISSION reject-once", "SKIPPED-WRITE (permission was refused)"]);
    expect(reject.proposals).toEqual([]);
  });

  it("flags deny-listed commands from external agents and never grants 'always' for them", async () => {
    const h = harness("always");
    await (await connect(h)).run([{ permission: "Clean up", command: "rm -rf ~" }]);
    expect(h.asked[0]!.danger).toContain("recursive delete");
    expect(messages(h.updates)).toEqual(["PERMISSION allow-once"]); // downgraded from allow-always
  });

  it("can cancel a running turn", async () => {
    const h = harness();
    const { c, session, run } = await connect(h);
    const p = run([{ say: "starting" }, { wait: 400 }, { say: "never shown" }]);
    await new Promise((r) => setTimeout(r, 100));
    c.cancel(session);
    expect((await p).stopReason).toBe("cancelled");
    expect(messages(h.updates)).toEqual(["starting"]);
  });

  it("rejects the connection cleanly if the agent cannot be started", async () => {
    const t = spawnTransport("definitely-not-a-real-binary-xyz", []);
    const c = new AcpClient(t, forgeAcpHandlers(harness().deps));
    await expect(c.initialize()).rejects.toThrow();
  });
});

describe("parseAcpConfig", () => {
  it("reads agents and reports problems", () => {
    const { agents, errors } = parseAcpConfig(JSON.stringify({ agents: { gemini: { command: "gemini", args: ["--experimental-acp"], env: { A: "1" } }, bad: {} } }));
    expect(agents).toEqual([{ name: "gemini", command: "gemini", args: ["--experimental-acp"], env: { A: "1" } }]);
    expect(errors).toEqual(['agent "bad" needs a "command"']);
    expect(parseAcpConfig("{x").errors[0]).toContain("not valid JSON");
    expect(parseAcpConfig(null)).toEqual({ agents: [], errors: [] });
  });
});
