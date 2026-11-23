// The agent process is started when the user focuses the input, so the first message does not wait for it.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, runtimeProcesses } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("focusing the input starts the agent process, and the first message then goes out as fast as a later one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-prewarm-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  const arrivals: number[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    arrivals.push(Date.now());
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "ok" } }] }));
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
    await expect.poll(runtimeProcesses, { message: "no agent process before the user touches the input" }).toBe(0);

    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.focus();
    await expect.poll(runtimeProcesses, { message: "focusing the input starts the agent process", timeout: 15_000 }).toBe(1);

    await input.fill("my very first message");
    const t0 = Date.now();
    await input.press("Enter");
    await expect.poll(() => arrivals.length, { timeout: 30_000 }).toBe(1);
    const firstMs = arrivals[0]! - t0;
    console.log(`PREWARM first message after focus: ${firstMs} ms to the model request`);
    expect(firstMs, "the process was already running, so no launch time is added").toBeLessThan(200);
    expect(runtimeProcesses(), "the pre-started process was used, not a second one").toBe(1);
  } finally {
    srv.close();
  }
});
