// The bundled `forge-code` executable run as a real process against a local mock model server (no network, no key).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
let bundle = "";
let server: Server;
let baseUrl = "";
const seenAuth: string[] = [];

beforeAll(async () => {
  bundle = join(mkdtempSync(join(tmpdir(), "forge-cli-bundle-")), "forge-code.cjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
  server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seenAuth.push(String(req.headers.authorization ?? ""));
    const answered = body.includes('"role":"tool"');
    res.writeHead(200, { "content-type": "text/event-stream" });
    const toolCall = { index: 0, id: "e", function: { name: "edit_file", arguments: JSON.stringify({ path: "a.js", old_string: "a = 1", new_string: "a = 100", reason: "bump a" }) } };
    res.write(sse({ choices: [{ delta: answered ? { content: "Bumped a." } : { tool_calls: [toolCall] } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}, 60_000);
afterAll(() => server.close());

/** Async on purpose: the mock model server lives in this process and must keep serving while the CLI runs. */
function forge(args: string[], cwd: string) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { cwd, env: { ...process.env, FORGE_API_KEY: "test-key" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, out, err })));
  });
}
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-cli-proc-"));
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  return dir;
};

describe("forge-code as a process", () => {
  it("proposes a diff and leaves the file alone by default", async () => {
    const dir = project();
    const r = await forge(["run", "bump a", "--provider", "openai", "--base-url", baseUrl, "--model", "m"], dir);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("-export const a = 1;");
    expect(r.out).toContain("+export const a = 100;");
    expect(readFileSync(join(dir, "a.js"), "utf8")).toBe("export const a = 1;\n");
    expect(seenAuth.at(-1)).toBe("Bearer test-key"); // the key came from the environment
  }, 40_000);

  it("writes with --apply", async () => {
    const dir = project();
    const r = await forge(["run", "bump a", "--apply", "--provider", "openai", "--base-url", baseUrl, "--model", "m"], dir);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(join(dir, "a.js"), "utf8")).toBe("export const a = 100;\n");
  }, 40_000);

  it("prints help, and exits 1 with a message on bad usage", async () => {
    expect(await forge(["--help"], tmpdir())).toMatchObject({ code: 0 });
    const bad = await forge(["frobnicate"], tmpdir());
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('unknown command "frobnicate"');
  }, 40_000);
});
