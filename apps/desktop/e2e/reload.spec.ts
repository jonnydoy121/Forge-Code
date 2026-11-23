// A page reload discards the JavaScript state that tracks child processes. They must be stopped, not orphaned.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, runtimeProcesses } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("reloading the window does not leave the agent process running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-reload-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "hello" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();
    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.fill("hi");
    await input.press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("hello", { timeout: 20_000 });
    expect(runtimeProcesses()).toBe(1);

    await page.reload();
    await expect.poll(runtimeProcesses, { timeout: 10_000 }).toBe(0);
  } finally {
    srv.close();
  }
});
