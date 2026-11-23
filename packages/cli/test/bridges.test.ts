import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedGateway } from "@forge/model-gateway";
import type { StreamEvent } from "@forge/protocol";
import { isSlackResponseUrl, linearQuestion, telegramPoll, verifyDiscord, verifyLinear, verifySlack, type Fetch } from "../src/bridges";
import { createAskServer, type AskServer } from "../src/serve";

const done: StreamEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
const say = (t: string): StreamEvent[] => [{ type: "text", delta: t }, done];
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

interface Sent {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}
const recorder = () => {
  const sent: Sent[] = [];
  const fetchFn: Fetch = async (url, init) => {
    sent.push({ url, ...init });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { sent, fetchFn };
};

let closer: (() => void) | null = null;
afterEach(() => closer?.());
async function start(env: Record<string, string>, gateway: ScriptedGateway, fetchFn: Fetch) {
  const io = { out: () => undefined, err: () => undefined, env, cwd: mkdtempSync(join(tmpdir(), "forge-bridge-")), gateway };
  const server: AskServer = createAskServer("a-long-enough-secret", io, [], fetchFn);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closer = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, post: (path: string, body: string, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers, body }) };
}

describe("Slack", () => {
  const secret = "slack-signing-secret";
  const now = Date.now();
  const signed = (body: string, ts = String(Math.floor(now / 1000))) => ({ "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${hmac(secret, `v0:${ts}:${body}`)}` });

  it("verifies the signature, and refuses a wrong secret, a changed body and a replay older than five minutes", () => {
    const body = "text=hi";
    expect(verifySlack(secret, signed(body), body, now)).toBe(true);
    expect(verifySlack("other-secret", signed(body), body, now)).toBe(false);
    expect(verifySlack(secret, signed(body), "text=changed", now)).toBe(false);
    const old = String(Math.floor(now / 1000) - 400);
    expect(verifySlack(secret, signed(body, old), body, now)).toBe(false);
    expect(verifySlack(secret, {}, body, now)).toBe(false);
  });

  it("only accepts Slack's own host as the place to reply", () => {
    expect(isSlackResponseUrl("https://hooks.slack.com/commands/T1/2/abc")).toBe(true);
    expect(isSlackResponseUrl("https://evil.example.com/hooks.slack.com/")).toBe(false);
    expect(isSlackResponseUrl("http://hooks.slack.com/x")).toBe(false);
  });

  it("answers a slash command: acknowledges at once, then posts the answer to the response URL", async () => {
    const { sent, fetchFn } = recorder();
    const { server, post } = await start({ FORGE_SLACK_SIGNING_SECRET: secret }, new ScriptedGateway([say("It is a Tuesday.")]), fetchFn);
    const body = new URLSearchParams({ text: "what day is it", response_url: "https://hooks.slack.com/commands/T1/2/abc" }).toString();
    const r = await post("/slack", body, signed(body, String(Math.floor(Date.now() / 1000))));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { text: string }).text).toContain("Working");
    await server.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://hooks.slack.com/commands/T1/2/abc");
    expect(JSON.parse(sent[0]!.body!).text).toBe("It is a Tuesday.");
  });

  it("rejects an unsigned request without running the model, and a reply URL on another host", async () => {
    const { sent, fetchFn } = recorder();
    const gw = new ScriptedGateway([say("x")]);
    const { server, post } = await start({ FORGE_SLACK_SIGNING_SECRET: secret }, gw, fetchFn);
    const body = new URLSearchParams({ text: "hi", response_url: "https://hooks.slack.com/a" }).toString();
    expect((await post("/slack", body)).status).toBe(401);
    const ts = String(Math.floor(Date.now() / 1000));
    expect((await post("/slack", body, { "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${"0".repeat(64)}` })).status).toBe(401); // well-formed, wrong
    const evil = new URLSearchParams({ text: "hi", response_url: "https://evil.example.com/a" }).toString();
    const r = await post("/slack", evil, signed(evil, String(Math.floor(Date.now() / 1000))));
    expect(((await r.json()) as { text: string }).text).toContain("Usage");
    await server.drain();
    expect(gw.requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("is switched off (404) when no signing secret is set", async () => {
    const { post } = await start({}, new ScriptedGateway([]), recorder().fetchFn);
    expect((await post("/slack", "text=hi")).status).toBe(404);
  });
});

describe("Discord", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  const signedBy = (body: string, ts = "1700000000", key = privateKey) => ({ "x-signature-timestamp": ts, "x-signature-ed25519": sign(null, Buffer.from(ts + body), key).toString("hex") });

  it("verifies Ed25519 signatures and refuses forged or malformed ones", () => {
    const body = '{"type":1}';
    expect(verifyDiscord(keyHex, signedBy(body), body)).toBe(true);
    expect(verifyDiscord(keyHex, signedBy(body), '{"type":2}')).toBe(false);
    expect(verifyDiscord(keyHex, signedBy(body, "1700000000", generateKeyPairSync("ed25519").privateKey), body)).toBe(false);
    expect(verifyDiscord(keyHex, {}, body)).toBe(false);
    expect(verifyDiscord("nothex", signedBy(body), body)).toBe(false);
    expect(verifyDiscord(keyHex, { ...signedBy(body), "x-signature-ed25519": "zz" }, body)).toBe(false);
  });

  it("answers Discord's ping, and a slash command with a deferred reply followed by the answer", async () => {
    const { sent, fetchFn } = recorder();
    const { server, post } = await start({ FORGE_DISCORD_PUBLIC_KEY: keyHex }, new ScriptedGateway([say("Blue.")]), fetchFn);
    const ping = '{"type":1}';
    const pong = await post("/discord", ping, signedBy(ping));
    expect(await pong.json()).toEqual({ type: 1 });

    const cmd = JSON.stringify({ type: 2, token: "tok_en-1", application_id: "123", data: { options: [{ name: "question", value: "sky colour?" }] } });
    const r = await post("/discord", cmd, signedBy(cmd));
    expect(await r.json()).toEqual({ type: 5 });
    await server.drain();
    expect(sent[0]!.url).toBe("https://discord.com/api/v10/webhooks/123/tok_en-1/messages/@original");
    expect(sent[0]!.method).toBe("PATCH");
    expect(JSON.parse(sent[0]!.body!).content).toBe("Blue.");
  });

  it("rejects an unsigned request", async () => {
    const gw = new ScriptedGateway([]);
    const { post } = await start({ FORGE_DISCORD_PUBLIC_KEY: keyHex }, gw, recorder().fetchFn);
    expect((await post("/discord", '{"type":1}')).status).toBe(401);
    expect(gw.requests).toHaveLength(0);
  });
});

describe("Linear", () => {
  const secret = "linear-webhook-secret";
  const hook = (body: object) => {
    const raw = JSON.stringify(body);
    return { raw, headers: { "linear-signature": hmac(secret, raw) } };
  };

  it("turns a new comment that mentions @forge into a question, and ignores everything else", () => {
    expect(linearQuestion({ action: "create", type: "Comment", data: { body: "@forge what does auth do?", issueId: "I1" } })).toEqual({ issueId: "I1", prompt: "what does auth do?" });
    expect(linearQuestion({ action: "create", type: "Comment", data: { body: "just chatting", issueId: "I1" } })).toBeNull();
    expect(linearQuestion({ action: "update", type: "Comment", data: { body: "@forge hi", issueId: "I1" } })).toBeNull();
    expect(linearQuestion({ action: "create", type: "Issue", data: { body: "@forge hi", issueId: "I1" } })).toBeNull();
    expect(linearQuestion({ action: "create", type: "Comment", data: { body: "@forge", issueId: "I1" } })).toBeNull();
  });

  it("verifies the signature and comments the answer back on the issue", async () => {
    const { sent, fetchFn } = recorder();
    const { server, post } = await start({ FORGE_LINEAR_WEBHOOK_SECRET: secret, FORGE_LINEAR_API_KEY: "lin_key" }, new ScriptedGateway([say("Auth checks the token.")]), fetchFn);
    const { raw, headers } = hook({ action: "create", type: "Comment", data: { body: "@forge explain auth", issueId: "I9" } });
    expect(verifyLinear(secret, headers, raw)).toBe(true);
    expect(verifyLinear("wrong", headers, raw)).toBe(false);
    const r = await post("/linear", raw, headers);
    expect(await r.json()).toEqual({ ok: true, handled: true });
    await server.drain();
    expect(sent[0]!.url).toBe("https://api.linear.app/graphql");
    expect(sent[0]!.headers!.authorization).toBe("lin_key");
    expect(JSON.parse(sent[0]!.body!).variables).toEqual({ issueId: "I9", body: "Auth checks the token." });
  });

  it("rejects a bad signature, and does not run for comments that do not mention it", async () => {
    const { sent, fetchFn } = recorder();
    const gw = new ScriptedGateway([]);
    const { post } = await start({ FORGE_LINEAR_WEBHOOK_SECRET: secret, FORGE_LINEAR_API_KEY: "k" }, gw, fetchFn);
    const { raw } = hook({ action: "create", type: "Comment", data: { body: "@forge hi", issueId: "I1" } });
    expect((await post("/linear", raw, { "linear-signature": "00" })).status).toBe(401);
    const quiet = hook({ action: "create", type: "Comment", data: { body: "no mention", issueId: "I1" } });
    expect(await (await post("/linear", quiet.raw, quiet.headers)).json()).toEqual({ ok: true, handled: false });
    expect(gw.requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("Telegram", () => {
  it("answers only the allowed chats, replies there, and moves past each update", async () => {
    const calls: Sent[] = [];
    let polls = 0;
    const fetchFn: Fetch = async (url, init) => {
      calls.push({ url, ...init });
      if (url.includes("getUpdates")) {
        polls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result:
              polls === 1
                ? [
                    { update_id: 10, message: { text: "hello bot", chat: { id: 42 } } },
                    { update_id: 11, message: { text: "let me in", chat: { id: 666 } } },
                  ]
                : [],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const asked: string[] = [];
    await telegramPoll({ token: "T0KEN", chats: ["42"], fetchFn, ask: async (p) => (asked.push(p), "hi human"), stop: () => polls >= 2, pollSeconds: 0 });
    expect(asked).toEqual(["hello bot"]); // the stranger's message was never answered
    const sends = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]!.body!)).toEqual({ chat_id: "42", text: "hi human" });
    expect(calls.filter((c) => c.url.includes("getUpdates")).at(-1)!.url).toContain("offset=12");
  });
});
