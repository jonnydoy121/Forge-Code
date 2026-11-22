// Spawns the real language servers (local processes, no network) and checks that LspClient
// surfaces a genuine type error as a diagnostic. Exit proof for "LSP diagnostics for TypeScript and Python".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient, type Diagnostic } from "../src/lib/lspClient";
import { pathToUri } from "../src/lib/uri";

const BIN = resolve(__dirname, "../../../node_modules/.bin");
const ext = process.platform === "win32" ? ".cmd" : "";

function start(server: string, cwd: string) {
  const proc: ChildProcess = spawn(join(BIN, server + ext), ["--stdio"], { cwd, shell: process.platform === "win32" });
  let buf = Buffer.alloc(0);
  let handler: (m: string) => void = () => {};
  proc.stdout!.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const len = Number(/content-length: *(\d+)/i.exec(buf.subarray(0, headerEnd).toString())?.[1]);
      if (buf.length < headerEnd + 4 + len) return;
      handler(buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString());
      buf = buf.subarray(headerEnd + 4 + len);
    }
  });
  const client = new LspClient({
    send: (m) => proc.stdin!.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`),
    onMessage: (h) => (handler = h),
  });
  return { proc, client };
}

const procs: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) {
    // shell:true on Windows wraps the server in cmd.exe, so kill the whole tree.
    if (process.platform === "win32" && p.pid) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"]);
    else p.kill();
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // best-effort temp cleanup; the OS temp dir is cleaned eventually
    }
  }
});

async function diagnosticsFor(server: string, file: string, languageId: string, source: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "forge-lsp-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  const path = join(dir, file);
  writeFileSync(path, source);
  const { proc, client } = start(server, dir);
  procs.push(proc);
  const got = new Promise<Diagnostic[]>((res) => {
    client.onDiagnostics((p) => {
      if (p.uri.toLowerCase().includes(file) && p.diagnostics.length > 0) res(p.diagnostics);
    });
  });
  await client.initialize(pathToUri(dir));
  client.openDocument(pathToUri(path), languageId, 1, source);
  return got;
}

const summary = (d: Diagnostic[]) => d.map((x) => `${x.severity}:${x.message.replace(/\s+/g, " ")}`).join("\n");

describe("real language servers", () => {
  it("typescript-language-server reports a type error", async () => {
    const diags = await diagnosticsFor("typescript-language-server", "a.ts", "typescript", 'const x: number = "not a number";\n', {
      "tsconfig.json": '{"compilerOptions":{"strict":true}}',
    });
    expect(summary(diags)).toMatch(/^1:.*string.*not assignable.*number/im);
  }, 60_000);

  it("pyright reports a type error", async () => {
    const diags = await diagnosticsFor("pyright-langserver", "a.py", "python", 'x: int = "not an int"\n');
    expect(summary(diags)).toMatch(/^1:.*(str|int)/im);
  }, 60_000);
});
