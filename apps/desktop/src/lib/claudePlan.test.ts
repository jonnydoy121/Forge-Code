import { describe, expect, it } from "vitest";
import { CLAUDE_AGENT, describeClaudePlan, detectClaudePlan, parseAuthStatus } from "./claudePlan";

const signedIn = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", loginExpiresAt: "2026-12-18T13:28:16.115Z" });

describe("parseAuthStatus", () => {
  it("recognises a Claude subscription login", () => {
    expect(parseAuthStatus(0, signedIn, "")).toEqual({ state: "signed-in", method: "claude.ai", subscription: true });
  });

  it("does not call an API-key or cloud login a subscription (it bills that account)", () => {
    expect(parseAuthStatus(0, JSON.stringify({ loggedIn: true, authMethod: "api_key" }), "")).toEqual({ state: "signed-in", method: "api_key", subscription: false });
    expect(parseAuthStatus(0, JSON.stringify({ loggedIn: true }), "")).toMatchObject({ subscription: false, method: "unknown" });
  });

  it("recognises signed out, including when the command exits non-zero but still prints the JSON", () => {
    expect(parseAuthStatus(0, JSON.stringify({ loggedIn: false }), "")).toEqual({ state: "signed-out" });
    expect(parseAuthStatus(1, JSON.stringify({ loggedIn: false }), "")).toEqual({ state: "signed-out" });
  });

  it("recognises that Claude Code is not installed, however the shell says so", () => {
    expect(parseAuthStatus(1, "", "'claude' is not recognized as an internal or external command")).toEqual({ state: "missing" });
    expect(parseAuthStatus(127, "", "bash: claude: command not found")).toEqual({ state: "missing" });
    expect(parseAuthStatus(1, "", "spawn claude ENOENT")).toEqual({ state: "missing" });
  });

  it("says unknown, with a reason, for anything it does not understand", () => {
    expect(parseAuthStatus(2, "", "some other failure")).toEqual({ state: "unknown", detail: "some other failure" });
    expect(parseAuthStatus(0, "not json", "")).toMatchObject({ state: "unknown" });
    expect(parseAuthStatus(3, "", "")).toEqual({ state: "unknown", detail: "exit code 3" });
  });
});

describe("detectClaudePlan", () => {
  it("runs `claude auth status` and reads the answer", async () => {
    const ran: string[] = [];
    const p = await detectClaudePlan(async (c) => (ran.push(c), { code: 0, stdout: signedIn, stderr: "" }));
    expect(ran).toEqual(["claude auth status"]);
    expect(p).toMatchObject({ state: "signed-in", subscription: true });
  });
  it("copes with a timeout and with the command failing to run at all", async () => {
    expect(await detectClaudePlan(async () => ({ code: null, stdout: "", stderr: "", timedOut: true }))).toMatchObject({ state: "unknown" });
    expect(await detectClaudePlan(async () => { throw new Error("boom"); })).toEqual({ state: "unknown", detail: "boom" });
  });
});

describe("describeClaudePlan and the preset", () => {
  it("explains each state in plain words, and hides Claude in local-only mode", () => {
    expect(describeClaudePlan(null, false)).toContain("Checking");
    expect(describeClaudePlan({ state: "signed-in", method: "claude.ai", subscription: true }, false)).toContain("Signed in with your Claude plan");
    expect(describeClaudePlan({ state: "signed-in", method: "api_key", subscription: false }, false)).toContain("will bill that account");
    expect(describeClaudePlan({ state: "signed-out" }, false)).toContain("run `claude`");
    expect(describeClaudePlan({ state: "missing" }, false)).toContain("not installed");
    expect(describeClaudePlan({ state: "signed-in", method: "claude.ai", subscription: true }, true)).toContain("Local-only mode");
  });
  it("the preset launches the official Claude Code adapter and sets no API key", () => {
    expect(CLAUDE_AGENT).toEqual({ name: "claude", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], env: {} });
  });
});
