// Streaming correctness under load: a fast model emits hundreds of tiny text deltas, each in its own network read. All of
// them must reach the screen, complete and in order, without blocking the UI thread for long.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const DELTAS = 800;

test(`${DELTAS} streamed deltas arrive complete and in order without blocking the UI`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-stream-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Paced like a fast local model: numbered words so order and completeness can be checked exactly.
    for (let i = 0; i < DELTAS; i++) {
      res.write(sse({ choices: [{ delta: { content: `w${i} ` } }] }));
      await new Promise((r) => setTimeout(r, 3)); // ~300 tokens/s, each arriving as its own network read
    }
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: DELTAS } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();

    // Count DOM changes in the conversation, and the longest stretch the main thread was blocked.
    await page.evaluate(() => {
      const w = window as unknown as { __mut: number; __long: number };
      w.__mut = 0;
      w.__long = 0;
      const box = document.querySelector('[data-testid="messages"]')!;
      new MutationObserver((list) => (w.__mut += list.length)).observe(box, { childList: true, subtree: true, characterData: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (w.__long = Math.max(w.__long, e.duration)))).observe({ entryTypes: ["longtask"] });
    });

    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.fill("stream a lot");
    await input.press("Enter");
    const last = page.locator('[data-testid="assistant"]:visible').last();
    await expect(last).toContainText(`w${DELTAS - 1}`, { timeout: 30_000 });

    // Complete and in order: exactly w0 w1 ... w799.
    const text = (await last.innerText()).trim();
    expect(text).toBe(Array.from({ length: DELTAS }, (_, i) => `w${i}`).join(" "));

    const m = await page.evaluate(() => {
      const w = window as unknown as { __mut: number; __long: number };
      return { mutations: w.__mut, longestTaskMs: Math.round(w.__long) };
    });
    expect(m.longestTaskMs).toBeLessThan(200); // no long task: typing and the Stop button stay responsive while text streams
  } finally {
    srv.close();
  }
});
