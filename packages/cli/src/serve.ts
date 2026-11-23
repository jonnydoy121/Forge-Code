// `forge-code serve`: a small HTTP endpoint so a chat bot, webhook or script can ask the agent questions.
//   POST /ask  {"prompt": "..."}   with  Authorization: Bearer <token>   ->   the `ask --json` result
// Read-only by design: it answers questions and never edits files or runs commands. Binds to 127.0.0.1 by default.
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { runCli, type Io } from "./cli";

const MAX_BODY = 64 * 1024;

function tokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAskServer(token: string, io: Io, extraArgs: string[] = []): Server {
  let busy = false; // one question at a time: the agent works in one folder
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/ask") return send(404, { error: "POST /ask is the only endpoint" });
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ") || !tokenOk(auth.slice(7), token)) return send(401, { error: "missing or wrong bearer token" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return send(413, { error: "request too large" });
    }
    let prompt: unknown;
    try {
      prompt = (JSON.parse(raw) as { prompt?: unknown }).prompt;
    } catch {
      return send(400, { error: "the body must be JSON" });
    }
    if (typeof prompt !== "string" || !prompt.trim()) return send(400, { error: 'send {"prompt": "..."}' });
    if (busy) return send(429, { error: "busy with another question" });
    busy = true;
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
      busy = false;
    }
  });
}

const USAGE = "Usage: forge-code serve [--port 8787] [--host 127.0.0.1] [--model m] [--provider p] [--base-url u] [--max-cost n] [--max-steps n]\nSet FORGE_SERVE_TOKEN to the secret (16+ characters) callers must send as a Bearer token.\n";

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
  const server = createAskServer(token, io, extra);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  io.out(`Listening on http://${host}:${port}/ask (read-only questions). Stop with Ctrl+C.\n`);
  await new Promise<void>(() => undefined);
  return 0;
}
