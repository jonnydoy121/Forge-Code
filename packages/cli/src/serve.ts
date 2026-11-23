// `forge-code serve`: a small HTTP server so bots, webhooks and scripts can ask the agent questions.
//   POST /ask      {"prompt": "..."}  with  Authorization: Bearer <FORGE_SERVE_TOKEN>
//   POST /slack    slash command         (enabled by FORGE_SLACK_SIGNING_SECRET)
//   POST /discord  slash command         (enabled by FORGE_DISCORD_PUBLIC_KEY)
//   POST /linear   comment webhook       (enabled by FORGE_LINEAR_WEBHOOK_SECRET + FORGE_LINEAR_API_KEY; trigger word FORGE_LINEAR_TRIGGER, default "@forge")
//   Telegram: long-polls when FORGE_TELEGRAM_TOKEN and FORGE_TELEGRAM_CHATS (comma-separated chat ids) are set.
// Read-only by design: it answers questions and never edits files or runs commands. Binds to 127.0.0.1 by default, so reaching it
// from Slack, Discord or Linear needs a tunnel or reverse proxy that you set up.
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { runCli, type Io } from "./cli";
import { discordPrompt, discordReply, linearQuestion, linearReply, slackCommand, slackReply, telegramPoll, verifyDiscord, verifyLinear, verifySlack, type DiscordInteraction, type Fetch } from "./bridges";

const MAX_BODY = 64 * 1024;

function tokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Answers one question through the real `ask` command. Questions run one at a time, in order: the agent works in one folder. */
export function makeAsk(io: Io, extraArgs: string[] = []): (prompt: string) => Promise<string> {
  let chain: Promise<unknown> = Promise.resolve();
  const once = async (prompt: string): Promise<string> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["ask", ` ${prompt.trim()}`, "--json", ...extraArgs], { ...io, out: (t) => out.push(t), err: (t) => err.push(t) });
    if (code === 1) throw new Error(err.join("").slice(-500) || "the agent failed");
    try {
      return String((JSON.parse(out.join("")) as { answer?: string }).answer ?? "");
    } catch {
      return out.join("").trim();
    }
  };
  return (prompt) => {
    const run = chain.then(() => once(prompt));
    chain = run.catch(() => undefined);
    return run;
  };
}

export type AskServer = Server & { /** Resolves when the replies sent in the background so far have been delivered (for tests). */ drain(): Promise<void> };

export function createAskServer(token: string, io: Io, extraArgs: string[] = [], fetchFn: Fetch = (url, init) => fetch(url, init)): AskServer {
  const ask = makeAsk(io, extraArgs);
  const env = io.env;
  const pending = new Set<Promise<unknown>>();
  const background = (work: () => Promise<void>) => {
    const p = work().catch(() => undefined);
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  const answer = (prompt: string) => ask(prompt).catch((e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`);
  let adHocBusy = false;

  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const route = req.url ?? "";
    const enabled: Record<string, boolean> = {
      "/ask": true,
      "/slack": !!env.FORGE_SLACK_SIGNING_SECRET,
      "/discord": !!env.FORGE_DISCORD_PUBLIC_KEY,
      "/linear": !!env.FORGE_LINEAR_WEBHOOK_SECRET && !!env.FORGE_LINEAR_API_KEY,
    };
    if (req.method !== "POST" || !enabled[route]) return send(404, { error: "not found" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return send(413, { error: "request too large" });
    }
    const headers = req.headers as Record<string, string | undefined>;

    if (route === "/slack") {
      if (!verifySlack(env.FORGE_SLACK_SIGNING_SECRET!, headers, raw)) return send(401, { error: "bad signature" });
      const cmd = slackCommand(raw);
      if (!cmd) return send(200, { response_type: "ephemeral", text: "Usage: /forge <question>" });
      background(async () => slackReply(fetchFn, cmd.responseUrl, await answer(cmd.text)));
      return send(200, { response_type: "ephemeral", text: "Working on it…" });
    }

    if (route === "/discord") {
      if (!verifyDiscord(env.FORGE_DISCORD_PUBLIC_KEY!, headers, raw)) return send(401, { error: "bad signature" });
      let i: DiscordInteraction;
      try {
        i = JSON.parse(raw) as DiscordInteraction;
      } catch {
        return send(400, { error: "bad body" });
      }
      if (i.type === 1) return send(200, { type: 1 }); // Discord's ping
      const prompt = discordPrompt(i);
      if (i.type !== 2 || !prompt) return send(200, { type: 4, data: { content: "Usage: give me a question as the command's text option." } });
      background(async () => discordReply(fetchFn, i, await answer(prompt)));
      return send(200, { type: 5 }); // "thinking…", replaced by the answer
    }

    if (route === "/linear") {
      if (!verifyLinear(env.FORGE_LINEAR_WEBHOOK_SECRET!, headers, raw)) return send(401, { error: "bad signature" });
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return send(400, { error: "bad body" });
      }
      const q = linearQuestion(payload, env.FORGE_LINEAR_TRIGGER || "@forge");
      if (q) background(async () => linearReply(fetchFn, env.FORGE_LINEAR_API_KEY!, q.issueId, await answer(q.prompt)));
      return send(200, { ok: true, handled: !!q });
    }

    // /ask
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ") || !tokenOk(auth.slice(7), token)) return send(401, { error: "missing or wrong bearer token" });
    let prompt: unknown;
    try {
      prompt = (JSON.parse(raw) as { prompt?: unknown }).prompt;
    } catch {
      return send(400, { error: "the body must be JSON" });
    }
    if (typeof prompt !== "string" || !prompt.trim()) return send(400, { error: 'send {"prompt": "..."}' });
    if (adHocBusy) return send(429, { error: "busy with another question" });
    adHocBusy = true;
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(["ask", ` ${prompt.trim()}`, "--json", ...extraArgs], { ...io, out: (t) => out.push(t), err: (t) => err.push(t) });
      let result: unknown = null;
      try {
        result = JSON.parse(out.join(""));
      } catch {
        /* no result */
      }
      send(code === 1 ? 500 : 200, { exitCode: code, result, error: code === 1 ? err.join("").slice(-500) : undefined });
    } finally {
      adHocBusy = false;
    }
  }) as AskServer;
  server.drain = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  return server;
}

const USAGE = `Usage: forge-code serve [--port 8787] [--host 127.0.0.1] [--model m] [--provider p] [--base-url u] [--max-cost n] [--max-steps n]
Set FORGE_SERVE_TOKEN (16+ characters) for POST /ask. Chat bridges switch on with their own variables:
  Slack     FORGE_SLACK_SIGNING_SECRET                               -> POST /slack   (slash command)
  Discord   FORGE_DISCORD_PUBLIC_KEY                                 -> POST /discord (interactions endpoint)
  Linear    FORGE_LINEAR_WEBHOOK_SECRET + FORGE_LINEAR_API_KEY       -> POST /linear  (comments containing @forge)
  Telegram  FORGE_TELEGRAM_TOKEN + FORGE_TELEGRAM_CHATS=id,id        (long polling, only the listed chats are answered)
`;

export async function runServe(args: string[], io: Io): Promise<number> {
  let port = 8787;
  let host = "127.0.0.1";
  const extra: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = args[i + 1];
    if (a === "--port" && v) {
      port = Number(v);
      i++;
    } else if (a === "--host" && v) {
      host = v;
      i++;
    } else if (["--model", "--provider", "--base-url", "--max-cost", "--max-steps"].includes(a) && v) {
      extra.push(a, v);
      i++;
    } else return io.err(`forge-code serve: unknown or incomplete option ${a}\n${USAGE}`), 1;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) return io.err("forge-code serve: --port must be 0-65535\n"), 1;
  const token = io.env.FORGE_SERVE_TOKEN;
  if (!token || token.length < 16) return io.err(`forge-code serve: set FORGE_SERVE_TOKEN to a secret of at least 16 characters\n${USAGE}`), 1;
  const tg = io.env.FORGE_TELEGRAM_TOKEN;
  const chats = (io.env.FORGE_TELEGRAM_CHATS ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  if (tg && chats.length === 0) return io.err("forge-code serve: FORGE_TELEGRAM_TOKEN needs FORGE_TELEGRAM_CHATS (the chat ids allowed to ask); a bot can be found by anyone\n"), 1;
  const server = createAskServer(token, io, extra);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const on = ["/ask", io.env.FORGE_SLACK_SIGNING_SECRET && "/slack", io.env.FORGE_DISCORD_PUBLIC_KEY && "/discord", io.env.FORGE_LINEAR_WEBHOOK_SECRET && io.env.FORGE_LINEAR_API_KEY && "/linear", tg && "telegram"].filter(Boolean);
  io.out(`Listening on http://${host}:${port} (${on.join(", ")}); read-only questions. Stop with Ctrl+C.\n`);
  if (tg) {
    const ask = makeAsk(io, extra);
    void telegramPoll({ token: tg, chats, fetchFn: (u, i) => fetch(u, i), ask }).catch((e: unknown) => io.err(`telegram stopped: ${e instanceof Error ? e.message : String(e)}\n`));
  }
  await new Promise<void>(() => undefined);
  return 0;
}
