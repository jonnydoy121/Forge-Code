// Assistant replies are formatted, and never interpreted as HTML.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const REPLY = [
  "## Fix",
  "",
  "The bug is in `add` and it is **serious**. See [the docs](https://example.com/docs).",
  "",
  "- first point",
  "- second point",
  "",
  "```ts",
  "export const add = (a: number, b: number) => a + b;",
  "```",
  "",
  '<img src=x onerror="window.__pwned = 1"> <b>not bold</b>',
].join("\n");

test("replies are formatted (code, emphasis, lists) and HTML in a reply stays inert text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-md-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Streamed in small pieces, as a model does, so unterminated markers are exercised on the way.
    for (let i = 0; i < REPLY.length; i += 7) res.write(sse({ choices: [{ delta: { content: REPLY.slice(i, i + 7) } }] }));
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
    await input.fill("explain");
    await input.press("Enter");

    const reply = page.locator('[data-testid="assistant"]:visible').last();
    await expect(reply.getByTestId("code-block")).toBeVisible({ timeout: 20_000 });

    await expect(reply.getByRole("heading", { name: "Fix" })).toBeVisible();
    await expect(reply.locator("code", { hasText: /^add$/ })).toBeVisible(); // inline code
    await expect(reply.locator("strong")).toHaveText("serious");
    await expect(reply.locator("li")).toHaveCount(2);
    await expect(reply.getByTestId("code-block")).toContainText("export const add = (a: number, b: number) => a + b;");
    await expect(reply.getByTestId("code-block").getByTestId("copy-code")).toBeVisible();

    // A link is shown but cannot navigate the app away.
    await expect(reply.getByText("the docs")).toBeVisible();
    expect(await reply.locator("a").count()).toBe(0);

    // HTML in the reply is text, not markup: no element was created and no script ran.
    expect(await reply.locator("img").count()).toBe(0);
    await expect(reply).toContainText('<img src=x onerror="window.__pwned = 1">');
    await expect(reply).toContainText("<b>not bold</b>");
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  } finally {
    srv.close();
  }
});
