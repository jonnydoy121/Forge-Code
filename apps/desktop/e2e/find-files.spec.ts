// The agent's find_files and grep options, end to end: model tool call -> real indexer over Tauri IPC -> result in the next request.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("find_files, case-insensitive grep and files-only grep work through the real index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-find-")).replaceAll("\\", "/");
  mkdirSync(`${dir}/src/auth`, { recursive: true });
  writeFileSync(`${dir}/src/auth/Login.ts`, "export function signIn() { return 1; }\n");
  writeFileSync(`${dir}/src/math.ts`, "export function ADD(a: number, b: number) { return a + b; }\n");
  writeFileSync(`${dir}/src/other.py`, "def add():\n    return 0\n");
  writeFileSync(`${dir}/.env`, "TOKEN=hunter2hunter2\n");
  // Only the index honours .gitignore (the plain-walk fallback does not), so this decoy proves the index answered.
  mkdirSync(`${dir}/gen`);
  writeFileSync(`${dir}/.gitignore`, "gen/\n");
  writeFileSync(`${dir}/gen/Login.ts`, "export const generated = 1;\n");

  const calls = [
    { name: "find_files", args: { pattern: "login" } }, // substring, case-insensitive
    { name: "find_files", args: { pattern: "*.{ts,py}" } }, // glob with alternatives
    { name: "grep", args: { pattern: "add", ignore_case: true, files_only: true } },
    { name: "grep", args: { pattern: "add", files_only: true } }, // case-sensitive: only the python file
    { name: "find_files", args: { pattern: "env" } }, // secrets are never listed
  ];
  let seen: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen = (JSON.parse(body).messages as { role: string; content: string }[]).filter((m) => m.role === "tool").map((m) => m.content);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const next = calls[seen.length];
    const delta = next ? { tool_calls: [{ index: 0, id: `c${seen.length}`, function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { content: "done" };
    res.write(sse({ choices: [{ delta }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const page = await openWorkspace(dir);
    await expect(page.getByTestId("index-status")).toContainText(/Indexed [1-9]\d* files/,{ timeout: 30_000 });
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();
    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.fill("find things");
    await input.press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("done", { timeout: 30_000 });

    expect(seen[0]).toBe("src/auth/Login.ts");
    expect(seen[1]!.split("\n")).toEqual(["src/auth/Login.ts", "src/math.ts", "src/other.py"]);
    expect(seen[2]!.split("\n")).toEqual(["src/math.ts", "src/other.py"]);
    expect(seen[3]).toBe("src/other.py");
    expect(seen[4]).toBe("no files found");
  } finally {
    srv.close();
  }
});
