// Parallel agent threads: independent conversations that run at the same time.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, runtimeProcesses } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("a slow thread does not block a second thread, and their conversations stay separate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-threads-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  const bodies: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    const slow = body.includes("slow question");
    if (slow) await new Promise((r) => setTimeout(r, 2500));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: slow ? "slow answer" : "fast answer" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const input = (page: import("@playwright/test").Page) => page.locator('[data-testid="agent-input"]:visible');
  const lastAnswer = (page: import("@playwright/test").Page) => page.locator('[data-testid="assistant"]:visible').last();
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();

    // Thread 1 starts a slow request.
    await input(page).fill("slow question");
    await input(page).press("Enter");
    await expect(page.getByTestId("thread-tab-main").getByLabel("running")).toBeVisible();

    // Thread 2 is created and answered while thread 1 is still running.
    await page.getByTestId("thread-new").click();
    await expect(page.getByTestId("thread-tab-t2")).toHaveAttribute("aria-selected", "true");
    await input(page).fill("fast question");
    await input(page).press("Enter");
    await expect(lastAnswer(page)).toContainText("fast answer", { timeout: 15_000 });
    await expect(page.getByTestId("thread-tab-main").getByLabel("running")).toBeVisible(); // thread 1 is still busy
    expect(runtimeProcesses(), "two threads, one shared agent process").toBe(1);

    // Back in thread 1 its own answer arrives; the conversations never mixed.
    await page.getByTestId("thread-tab-main").click();
    await expect(lastAnswer(page)).toContainText("slow answer", { timeout: 15_000 });
    await expect(page.getByTestId("thread-tab-main").getByLabel("running")).toHaveCount(0);
    const fastRequest = bodies.find((b) => b.includes("fast question"))!;
    expect(fastRequest).not.toContain("slow question");

    // A finished thread can be closed; the main thread cannot.
    await page.getByTestId("thread-tab-t2").click();
    await expect(page.getByTestId("thread-close-t2")).toBeVisible();
    await expect(page.getByTestId("thread-close-main")).toHaveCount(0);
    await page.getByTestId("thread-close-t2").click();
    await expect(page.getByTestId("thread-tab-t2")).toHaveCount(0);
  } finally {
    srv.close();
  }
});
