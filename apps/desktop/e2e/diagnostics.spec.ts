// The agent's `diagnostics` tool, against the real language server: a file the editor never opened, the agent's own unaccepted
// edit to a file that IS open, and a file type with no server.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("diagnostics reports real errors for unopened files and for the agent's pending edits, and says when it cannot check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-diag-")).replaceAll("\\", "/");
  mkdirSync(`${dir}/src`);
  writeFileSync(`${dir}/src/bad.ts`, 'export const n: number = "not a number";\n');
  writeFileSync(`${dir}/src/good.ts`, "export function one(): number {\n  return 1;\n}\n");
  writeFileSync(`${dir}/README.md`, "# hi\n");
  writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler" }, include: ["src"] }));

  const calls = [
    { name: "diagnostics", args: { path: "src/bad.ts" } }, // never opened in the editor
    { name: "edit_file", args: { path: "src/good.ts", old_string: "return 1;", new_string: 'return "one";', reason: "make it return text" } },
    { name: "diagnostics", args: { path: "src/good.ts" } }, // open in the editor, and the pending edit differs from disk
    { name: "diagnostics", args: { path: "README.md" } }, // no language server for markdown
  ];
  let outputs: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const c of req) body += c;
    outputs = (JSON.parse(body).messages as { role: string; content: string }[]).filter((m) => m.role === "tool").map((m) => m.content);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const next = calls[outputs.length];
    const delta = next ? { tool_calls: [{ index: 0, id: `c${outputs.length}`, function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { content: "checked" };
    res.write(sse({ choices: [{ delta }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("review-mode").selectOption("review");
    await page.getByTestId("settings-toggle").click();

    // Open good.ts so the editor owns it (the harder case: the check must not disturb it).
    await page.getByTestId("tree-src").click();
    await page.getByTestId("tree-good.ts").click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("return 1", { timeout: 20_000 });

    await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.fill("check my work");
    await input.press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("checked", { timeout: 90_000 });

    expect(outputs[0]).toMatch(/^src\/bad\.ts: 1 error\nsrc\/bad\.ts:1:14 error 2322: Type 'string' is not assignable to type 'number'\./);
    expect(outputs[1]).toBeTruthy(); // the edit was staged for review
    expect(outputs[2]).toMatch(/^src\/good\.ts: 1 error\nsrc\/good\.ts:2:3 error 2322: Type 'string' is not assignable to type 'number'\./);
    expect(outputs[3]).toMatch(/^README\.md: not checked, no language server/);

    // The edit is still only pending: the file on disk is untouched, and the editor still shows the saved text.
    expect(readFileSync(`${dir}/src/good.ts`, "utf8")).toContain("return 1;");
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("return 1");

    // The check did not leave the editor's own document in a bad state: editing and saving still works.
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("export const two = 2;");
    await page.keyboard.press("Control+S");
    await expect.poll(() => readFileSync(`${dir}/src/good.ts`, "utf8")).toContain("export const two = 2;");
  } finally {
    srv.close();
  }
});
