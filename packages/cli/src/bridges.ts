// Chat bridges for `forge-code serve`. Each one answers read-only questions (the `ask` command: no edits, no commands).
// Every inbound request is verified with the platform's own signature scheme before anything runs.
// Tested against mocks only: none of these has been run against the live Slack, Discord, Telegram or Linear services.
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type Ask = (prompt: string) => Promise<string>;

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const hmacHex = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

// ---------- Slack: slash command ----------
/** Slack signs `v0:<timestamp>:<body>` with the app's signing secret; requests older than five minutes are refused (replay). */
export function verifySlack(secret: string, headers: Record<string, string | undefined>, rawBody: string, nowMs = Date.now()): boolean {
  const ts = headers["x-slack-request-timestamp"];
  const sig = headers["x-slack-signature"];
  if (!ts || !sig || !/^\d+$/.test(ts) || Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  return safeEqual(sig, `v0=${hmacHex(secret, `v0:${ts}:${rawBody}`)}`);
}

/** Slack gives a one-time `response_url`; only Slack's own host is accepted so a forged field cannot aim the reply elsewhere. */
export const isSlackResponseUrl = (u: string) => /^https:\/\/hooks\.slack\.com\//.test(u);

export function slackCommand(rawBody: string): { text: string; responseUrl: string } | null {
  const p = new URLSearchParams(rawBody);
  const text = (p.get("text") ?? "").trim();
  const responseUrl = p.get("response_url") ?? "";
  return text && isSlackResponseUrl(responseUrl) ? { text, responseUrl } : null;
}

export async function slackReply(fetchFn: Fetch, responseUrl: string, text: string): Promise<void> {
  await fetchFn(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "in_channel", text: clip(text, 3000) }) });
}

// ---------- Discord: slash command interactions ----------
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Discord signs `<timestamp><body>` with Ed25519; the application's public key is given as 64 hex characters. */
export function verifyDiscord(publicKeyHex: string, headers: Record<string, string | undefined>, rawBody: string): boolean {
  const sig = headers["x-signature-ed25519"];
  const ts = headers["x-signature-timestamp"];
  if (!sig || !ts || !/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(ts + rawBody), key, Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

export interface DiscordInteraction {
  type: number;
  token?: string;
  application_id?: string;
  data?: { options?: { name: string; value?: unknown }[] };
}
/** The text of the first string option of a slash command (any command name). */
export function discordPrompt(i: DiscordInteraction): string {
  const v = i.data?.options?.find((o) => typeof o.value === "string")?.value;
  return typeof v === "string" ? v.trim() : "";
}
export async function discordReply(fetchFn: Fetch, i: DiscordInteraction, text: string): Promise<void> {
  if (!i.token || !i.application_id || !/^[\w-]+$/.test(i.token) || !/^\d+$/.test(i.application_id)) return;
  await fetchFn(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: clip(text, 2000) }) });
}

// ---------- Linear: comment webhook ----------
/** Linear sends the hex HMAC-SHA256 of the raw body, keyed with the webhook secret, in `linear-signature`. */
export function verifyLinear(secret: string, headers: Record<string, string | undefined>, rawBody: string): boolean {
  const sig = headers["linear-signature"];
  return !!sig && safeEqual(sig, hmacHex(secret, rawBody));
}

/** A new comment that mentions the trigger (default "@forge") becomes a question; the issue id says where to answer. */
export function linearQuestion(payload: unknown, trigger = "@forge"): { issueId: string; prompt: string } | null {
  const p = payload as { action?: string; type?: string; data?: { body?: string; issueId?: string; issue?: { id?: string } } };
  if (p?.action !== "create" || p.type !== "Comment") return null;
  const body = p.data?.body ?? "";
  const issueId = p.data?.issueId ?? p.data?.issue?.id;
  if (!issueId || !body.toLowerCase().includes(trigger.toLowerCase())) return null;
  const prompt = body.replace(new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "").trim();
  return prompt ? { issueId, prompt } : null;
}
export async function linearReply(fetchFn: Fetch, apiKey: string, issueId: string, text: string): Promise<void> {
  await fetchFn("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: apiKey },
    body: JSON.stringify({ query: "mutation($issueId: String!, $body: String!) { commentCreate(input: {issueId: $issueId, body: $body}) { success } }", variables: { issueId, body: clip(text, 10000) } }),
  });
}

// ---------- Telegram: long polling ----------
export interface TelegramOptions {
  token: string;
  /** Only these chat ids are answered: a bot is findable by anyone, so there is no "answer everyone" mode. */
  chats: string[];
  fetchFn: Fetch;
  ask: Ask;
  /** Polling stops when this returns true (tests; the server runs until killed). */
  stop?: () => boolean;
  pollSeconds?: number;
}
export async function telegramPoll(o: TelegramOptions): Promise<void> {
  const api = `https://api.telegram.org/bot${o.token}`;
  let offset = 0;
  while (!o.stop?.()) {
    const r = await o.fetchFn(`${api}/getUpdates?timeout=${o.pollSeconds ?? 30}&offset=${offset}`);
    const body = (await r.json()) as { ok?: boolean; result?: { update_id: number; message?: { text?: string; chat?: { id?: number } } }[] };
    for (const u of body.result ?? []) {
      offset = u.update_id + 1;
      const chat = String(u.message?.chat?.id ?? "");
      const text = u.message?.text?.trim();
      if (!text || !o.chats.includes(chat)) continue;
      const answer = await o.ask(text).catch((e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`);
      await o.fetchFn(`${api}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: clip(answer, 4096) }) });
    }
  }
}
