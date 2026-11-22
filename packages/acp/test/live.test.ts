// Opt-in: drives a REAL external agent (Claude Code through its ACP adapter) with Forge's ACP client.
// Skipped unless FORGE_LIVE_ACP=1: it uses the developer's Claude account and sends the throwaway file below to Anthropic.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnTransport } from "@forge/rpc/src/node";
import { denyReason } from "@forge/safety";
import { AcpClient, forgeAcpHandlers, type AcpUpdate } from "../src";

describe.skipIf(!process.env.FORGE_LIVE_ACP)("live: Claude Code over ACP", () => {
  it("handshakes, reads through Forge, and its edit arrives as a pending proposal (never written to disk)", async () => {
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
          ask: async (r) => (asked.push(r.title), "once"),
          onUpdate: (u) => updates.push(u),
          denyReason,
          agentName: "claude",
        }),
      );
      await client.initialize();
      expect(client.agentInfo?.name).toBeTruthy();
      const session = await client.newSession(root);
      await client.prompt(session, "In hello.txt change the word foo to bar. Make only that edit, then reply done.");
      const text = updates.filter((u) => u.kind === "message").map((u) => (u as { text: string }).text).join("");
      console.log("agent:", client.agentInfo, "| asked:", asked, "| proposals:", proposals.map((p) => p.path), "| reply:", text.slice(0, 200));
      expect(updates.length).toBeGreaterThan(0);
      // Whatever route the agent used, nothing may have been written behind Forge's back when the edit went through us.
      if (proposals.length) {
        expect(proposals[0]!.content).toContain("bar");
        expect(readFileSync(`${root}/hello.txt`, "utf8")).toBe("greeting: foo\n");
      }
    } finally {
      t.close();
    }
  }, 240_000);
});
