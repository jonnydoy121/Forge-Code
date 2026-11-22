// End to end (real files, no UI): an agent run proposes a multi-file refactor; the developer reviews it hunk by
// hunk; the whole step can then be rolled back to the exact original bytes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StreamEvent } from "@forge/protocol";
import { ScriptedGateway } from "@forge/model-gateway";
import { READ_TOOLS, createEditTools, createToolHost } from "@forge/tool-host";
import { nodeFs } from "@forge/tool-host/src/node-fs";
import { FileCheckpointStore } from "@forge/checkpoints";
import { nodeCheckpointFs } from "@forge/checkpoints/src/node";
import { PendingChanges, type ReviewMode } from "@forge/review";
import { Runtime } from "../src";

let root: string;
const files = {
  "src/user.ts": "export class UserService {\r\n  getById(id: string) {\r\n    return id;\r\n  }\r\n}\r\n",
  "src/api.ts": "import { UserService } from './user';\nconst svc = new UserService();\nexport const handle = (id: string) => svc.getById(id);\n",
  "src/user.test.ts": "import { UserService } from './user';\nnew UserService().getById('1');\nnew UserService().getById('2');\n",
};
const abs = (rel: string) => `${root}/${rel}`;
const read = (rel: string) => readFileSync(abs(rel), "utf8");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-refactor-")).replace(/\\/g, "/");
  mkdirSync(`${root}/src`);
  for (const [rel, text] of Object.entries(files)) writeFileSync(abs(rel), text);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });
const done: StreamEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };

function harness(mode: ReviewMode) {
  const checkpoints = new FileCheckpointStore({ fs: nodeCheckpointFs, dir: `${root}/.forge/checkpoints/test-${mode}` });
  // eslint-disable-next-line prefer-const
  let runtime: Runtime;
  const pending = new PendingChanges({ fs: nodeCheckpointFs, checkpoints, mode: () => mode, historyLength: () => runtime.history.length });
  const overlay = { ...nodeFs, readFile: async (p: string) => { const e = pending.effective(p); if (e === null) throw new Error("ENOENT"); return e ?? nodeFs.readFile(p); } };
  const tools = createToolHost({
    root,
    fs: overlay,
    tools: [...READ_TOOLS, ...createEditTools({ read: async (p) => { const e = pending.effective(p); return e !== undefined ? e : nodeCheckpointFs.read(p); }, propose: async (p, c, r) => { const o = await pending.propose(p, c, r); return { status: o.status, added: o.stats.added, removed: o.stats.removed, checkpoint: o.checkpoint }; } })],
  });
  const gateway = new ScriptedGateway([
    [call("1", "read_file", { path: "src/user.ts" }), done],
    [
      call("2", "edit_file", { path: "src/user.ts", old_string: "getById", new_string: "findById", reason: "rename method" }),
      call("3", "edit_file", { path: "src/api.ts", old_string: "getById", new_string: "findById", reason: "update caller" }),
      call("4", "edit_file", { path: "src/user.test.ts", old_string: "getById", new_string: "findById", replace_all: true, reason: "update tests" }),
      done,
    ],
    [call("5", "read_file", { path: "src/api.ts" }), done],
    [{ type: "text", delta: "Renamed getById to findById in 3 files." }, done],
  ]);
  runtime = new Runtime({ gateway, tools, provider: "p", model: "m" });
  return { runtime, pending, checkpoints, gateway };
}

async function drain(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("multi-file refactor: review and full rollback", () => {
  it("proposes edits without touching disk, shows them to the agent via the overlay, then rolls back exactly", async () => {
    const { runtime, pending, checkpoints, gateway } = harness("review");
    pending.beginChangeSet("Rename getById to findById", 1);
    const events = await drain(runtime.run({ mode: "agent", prompt: "Rename UserService.getById to findById" }));

    // Nothing on disk yet.
    for (const [rel, text] of Object.entries(files)) expect(read(rel)).toBe(text);
    // Three files pending, one change set, tagged with step 1.
    expect(pending.list().map((f) => f.path.slice(root.length + 1))).toEqual(["src/api.ts", "src/user.test.ts", "src/user.ts"]);
    expect(pending.changeSets()).toHaveLength(1);
    expect(pending.list().every((f) => f.step === 1)).toBe(true);
    // The agent re-reading api.ts saw its own proposed version, not the stale disk.
    const reread = gateway.requests[3]!.messages.filter((m) => m.role === "tool").at(-1)!.content;
    expect(reread).toContain("svc.findById(id)");
    expect(events.at(-1)).toMatchObject({ type: "done" });

    // Review: accept everything in the change set.
    const result = await pending.resolveEverything("accepted", pending.currentChangeSet);
    expect(Object.values(result)).toEqual(["applied", "applied", "applied"]);
    expect(read("src/user.ts")).toBe(files["src/user.ts"].replace("getById", "findById")); // CRLF preserved
    expect(read("src/user.test.ts")).not.toContain("getById");
    expect(read("src/api.ts")).toContain("svc.findById(id)");

    // Checkpoints record the step and the conversation length.
    const cps = await checkpoints.list();
    expect(cps.map((c) => c.step)).toEqual([1, 1, 1]);
    expect(cps[0]!.historyLength).toBeGreaterThan(0);

    // Roll back the step: every file is byte-identical to the original.
    const restored = await checkpoints.rollback({ step: 1 });
    expect(restored).toHaveLength(3);
    for (const [rel, text] of Object.entries(files)) expect(read(rel)).toBe(text);
  });

  it("human control: rejecting one hunk applies the rest; rolling back the step restores everything", async () => {
    // fresh state
    for (const [rel, text] of Object.entries(files)) writeFileSync(abs(rel), text);
    const { runtime, pending, checkpoints } = harness("review");
    pending.beginChangeSet("Rename", 2);
    await drain(runtime.run({ mode: "agent", prompt: "rename" }));

    const test = pending.get(abs("src/user.test.ts"))!;
    expect(test.hunks).toHaveLength(1); // two adjacent call lines form one hunk
    // Split the review: accept user.ts and api.ts, reject the test change.
    await pending.resolveAll(abs("src/user.ts"), "accepted");
    await pending.resolveAll(abs("src/api.ts"), "accepted");
    await pending.resolveAll(abs("src/user.test.ts"), "rejected");
    expect(read("src/user.test.ts")).toBe(files["src/user.test.ts"]);
    expect(read("src/user.ts")).toContain("findById");

    await checkpoints.rollback({ step: 2 });
    for (const [rel, text] of Object.entries(files)) expect(read(rel)).toBe(text);
  });

  it("auto mode applies immediately and the checkpoint still allows a full undo", async () => {
    for (const [rel, text] of Object.entries(files)) writeFileSync(abs(rel), text);
    const { runtime, pending, checkpoints } = harness("auto");
    await drain(runtime.run({ mode: "agent", prompt: "rename" }));
    expect(pending.list()).toEqual([]);
    expect(read("src/api.ts")).toContain("findById");
    await checkpoints.rollback({ toCheckpoint: (await checkpoints.list())[0]!.id });
    for (const [rel, text] of Object.entries(files)) expect(read(rel)).toBe(text);
    expect(existsSync(abs("src/user.ts"))).toBe(true);
  });

  it("ask mode cannot propose edits at all", async () => {
    for (const [rel, text] of Object.entries(files)) writeFileSync(abs(rel), text);
    const { runtime, pending } = harness("review");
    await drain(runtime.run({ mode: "ask", prompt: "rename" }));
    expect(pending.list()).toEqual([]);
  });
});
