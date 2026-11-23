// Verification catches language-server errors in a file the agent created and the developer never opened.
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

test("the verification report flags a type error in a file the editor never opened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-vu-")).replaceAll("\\", "/");
  mkdirSync(`${dir}/src`);
  writeFileSync(`${dir}/src/ok.ts`, "export const ok = 1;\n");
  writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler" }, include: ["src"] }));
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "demo" }));

  let wrote = false;
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = wrote ? { content: "created it" } : { tool_calls: [{ index: 0, id: "w1", function: { name: "write_file", arguments: JSON.stringify({ path: "src/broken.ts", content: 'export const n: number = "not a number";\n', reason: "new module" }) } }] };
    wrote = true;
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
    await page.getByTestId("review-mode").selectOption("auto"); // the file lands on disk without a review step
    await page.getByTestId("settings-toggle").click();

    await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.fill("add a module");
    await input.press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("created it", { timeout: 90_000 });
    expect(readFileSync(`${dir}/src/broken.ts`, "utf8")).toContain("not a number"); // written, and never opened in the editor
    await expect(page.getByRole("tab", { name: /broken\.ts/ })).toHaveCount(0);

    // The report names the language-server check as failed, with the real error and its position.
    const card = page.getByTestId("report-card").last();
    await expect(card.getByTestId("report-label")).toHaveText("Checks failed", { timeout: 60_000 });
    const lsp = card.getByTestId("report-check").filter({ hasText: "Language server" });
    await expect(lsp).toContainText("✗");
    await expect(lsp).toContainText("src/broken.ts:1:14");
    await expect(lsp).toContainText("Type 'string' is not assignable to type 'number'");
  } finally {
    srv.close();
  }
});
