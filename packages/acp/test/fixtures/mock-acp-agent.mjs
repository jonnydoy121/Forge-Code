// A minimal ACP agent over stdio, for tests. The prompt text is a JSON script of steps:
//   {"say": "..."} | {"read": "path"} | {"permission": "title", "command": "optional shell command"}
//   {"replace": {"path": "p", "from": "a", "to": "b"}} | {"write": {"path": "p", "content": "..."}}
// A rejected permission skips every later write/replace step.
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let nextId = 1000;
const waiting = new Map();
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); out({ jsonrpc: "2.0", id, method, params }); });
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
let cancelled = false;

async function runPrompt(id, params) {
  const sessionId = params.sessionId;
  cancelled = false;
  const steps = JSON.parse(params.prompt.map((p) => p.text).join(""));
  let allowed = true;
  let n = 0;
  for (const step of steps) {
    if (cancelled) return out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    if (step.say) say(sessionId, step.say);
    else if (step.read) {
      const tc = `read-${++n}`;
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: tc, title: `Read ${step.read}`, kind: "read", status: "in_progress" });
      try {
        const r = await request("fs/read_text_file", { sessionId, path: step.read });
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tc, status: "completed", content: [{ type: "text", text: `read ${r.content.length} chars` }] });
        say(sessionId, `READ-OK ${r.content.split("\n")[0]}`);
      } catch (e) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tc, status: "failed" });
        say(sessionId, `READ-FAILED ${e.message}`);
      }
    } else if (step.permission) {
      const r = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: `perm-${++n}`, title: step.permission, kind: "execute", rawInput: step.command ? { command: step.command } : undefined },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const chosen = r.outcome.outcome === "selected" ? r.outcome.optionId : "cancelled";
      say(sessionId, `PERMISSION ${chosen}`);
      if (chosen.startsWith("reject") || chosen === "cancelled") allowed = false;
    } else if (step.replace || step.write) {
      if (!allowed) { say(sessionId, "SKIPPED-WRITE (permission was refused)"); continue; }
      const tc = `edit-${++n}`;
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: tc, title: `Edit ${(step.replace || step.write).path}`, kind: "edit", status: "in_progress" });
      try {
        let content;
        if (step.write) content = step.write.content;
        else {
          const r = await request("fs/read_text_file", { sessionId, path: step.replace.path });
          content = r.content.split(step.replace.from).join(step.replace.to);
        }
        await request("fs/write_text_file", { sessionId, path: (step.replace || step.write).path, content });
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tc, status: "completed" });
        say(sessionId, "WRITE-OK");
      } catch (e) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tc, status: "failed" });
        say(sessionId, `WRITE-FAILED ${e.message}`);
      }
    } else if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
  }
  update(sessionId, { sessionUpdate: "plan", entries: [{ content: "finish", priority: "high", status: "completed" }] });
  out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && m.id !== undefined) {
    const w = waiting.get(m.id);
    if (w) {
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error.message));
      else w.resolve(m.result);
    }
    return;
  }
  if (m.method === "initialize") return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: "mock-agent", version: "0.1" }, agentCapabilities: {}, authMethods: [] } });
  if (m.method === "session/new") return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-1" } });
  if (m.method === "session/prompt") return void runPrompt(m.id, m.params);
  if (m.method === "session/cancel") { cancelled = true; return; }
  if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
});
