import { describe, expect, it } from "vitest";
import { CLAUDE_AGENT, claudePlanCached, describeClaudePlan, detectClaudePlan, parseAuthStatus, readCachedPlan } from "./claudePlan";

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

describe("claudePlanCached (so the mode list is right from the first paint)", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  const counting = (stdout: string) => {
    let n = 0;
    return { run: async () => (n++, { code: 0, stdout, stderr: "" }), calls: () => n };
  };

  it("asks once, then answers from the cache for ten minutes", async () => {
    const store = memory();
    const c = counting(signedIn);
    const first = await claudePlanCached(c.run, { store, now: 1_000 });
    expect(first).toMatchObject({ state: "signed-in" });
    expect(await claudePlanCached(c.run, { store, now: 2_000 })).toEqual(first);
    expect(c.calls()).toBe(1);
    expect(readCachedPlan(store, 5 * 60_000)).toEqual(first);
    expect(readCachedPlan(store, 11 * 60_000)).toBeNull(); // too old
    await claudePlanCached(c.run, { store, now: 11 * 60_000 });
    expect(c.calls()).toBe(2);
  });

  it("asks again when forced (Check again), and never remembers an unknown answer", async () => {
    const store = memory();
    const c = counting(signedIn);
    await claudePlanCached(c.run, { store, now: 1 });
    await claudePlanCached(c.run, { store, now: 2, force: true });
    expect(c.calls()).toBe(2);
    const bad = memory();
    const failing = counting("not json");
    expect(await claudePlanCached(failing.run, { store: bad, now: 1 })).toMatchObject({ state: "unknown" });
    await claudePlanCached(failing.run, { store: bad, now: 2 });
    expect(failing.calls()).toBe(2); // not cached
  });

  it("shares one question between panels that ask at the same time", async () => {
    let n = 0;
    const slow = async () => (n++, await new Promise((r) => setTimeout(r, 20)), { code: 0, stdout: signedIn, stderr: "" });
    const store = memory();
    const [a, b, c] = await Promise.all([claudePlanCached(slow, { store: null, now: 1 }), claudePlanCached(slow, { store: null, now: 1 }), claudePlanCached(slow, { store: null, now: 1 })]);
    expect(n).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(readCachedPlan(store)).toBeNull();
  });

  it("copes with unreadable or hostile storage", async () => {
    expect(readCachedPlan({ getItem: () => "{not json", setItem: () => {} })).toBeNull();
    expect(readCachedPlan({ getItem: () => JSON.stringify({ at: "yesterday", plan: { state: "signed-in" } }), setItem: () => {} })).toBeNull();
    expect(readCachedPlan({ getItem: () => { throw new Error("denied"); }, setItem: () => {} })).toBeNull();
    const throwing = { getItem: () => null, setItem: () => { throw new Error("full"); } };
    expect(await claudePlanCached(counting(signedIn).run, { store: throwing, now: 1 })).toMatchObject({ state: "signed-in" });
  });
});
