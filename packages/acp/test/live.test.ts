// Opt-in: drives a REAL external agent (Claude Code through its ACP adapter) with Forge's ACP client.
// Skipped unless FORGE_LIVE_ACP=1: it uses the developer's Claude account and sends the throwaway file below to Anthropic.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnTransport } from "@forge/rpc/src/node";
import { denyReason } from "@forge/safety";
import { AcpClient, forgeAcpHandlers, type AcpUpdate } from "../src";

const isRead = (title: string) => /^\w+: Read /.test(title);

describe.skipIf(!process.env.FORGE_LIVE_ACP)("live: Claude Code over ACP", () => {
  it("handshakes, is forced into ask-first mode, and its edit becomes a pending proposal (nothing is written to disk)", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-live-acp-")).replace(/[\\]/g, "/");
    writeFileSync(`${root}/hello.txt`, "greeting: foo\n");
    const proposals: { path: string; content: string; reason: string }[] = [];
    const updates: AcpUpdate[] = [];
    const asked: string[] = [];
    const t = spawnTransport(process.platform === "win32" ? "npx.cmd" : "npx", ["-y", "@agentclientprotocol/claude-agent-acp"], { cwd: root });
    try {
      const client = new AcpClient(
        t,
        forgeAcpHandlers({
          root,
          read: async (p) => {
            try {
              return readFileSync(p, "utf8");
            } catch {
              return null;
            }
          },
          propose: async (path, content, reason) => (proposals.push({ path, content, reason }), { status: "pending" }),
          ask: async (r) => (asked.push(r.title), isRead(r.title) ? "once" : "deny"), // allow reads, refuse everything else
          onUpdate: (u) => updates.push(u),
          denyReason,
          agentName: "claude",
        }),
      );
      await client.initialize();
      expect(client.agentInfo?.name).toBeTruthy();
      const session = await client.newSession(root);
      console.log("modes:", JSON.stringify(client.modes));
      await client.prompt(session, "In hello.txt change the word foo to bar. Make only that edit, then reply done.");
      const text = updates.filter((u) => u.kind === "message").map((u) => (u as { text: string }).text).join("");
      console.log("agent:", client.agentInfo, "| asked:", asked, "| proposals:", proposals.map((p) => p.path), "| reply:", text.slice(0, 200));
      console.log("tool calls:", JSON.stringify(updates.filter((u) => u.kind === "tool_call" || u.kind === "tool_call_update")).slice(0, 1500));
      const onDisk = readFileSync(`${root}/hello.txt`, "utf8");
      console.log("hello.txt on disk afterwards:", JSON.stringify(onDisk), "| update kinds:", [...new Set(updates.map((u) => u.kind))]);
      expect(updates.length).toBeGreaterThan(0);
      // Forge forced the agent into its ask-first mode; its Edit arrived as a pending proposal, was never prompted for as a
      // direct write, and nothing reached the disk.
      expect(client.modes.current).toBe("default");
      expect(asked.every(isRead), `unexpected prompts: ${asked.join(", ")}`).toBe(true);
      expect(proposals, "the agent's edit was not captured as a proposal").toHaveLength(1);
      expect(proposals[0]!.content).toBe("greeting: bar\n");
      expect(onDisk).toBe("greeting: foo\n");
    } finally {
      t.close();
    }
  }, 240_000);
});
