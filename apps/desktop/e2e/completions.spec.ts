// Edit prediction: ghost-text completions. Off by default (nothing is sent); on, a pause in typing shows ghost text.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("completions are off by default, then show ghost text that Tab accepts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-complete-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const answer =");
  const bodies: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: " 42;" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const completionRequests = () => bodies.filter((b) => b.includes("<<CURSOR>>")).length;
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await expect(page.getByTestId("completions-toggle")).not.toBeChecked(); // off by default
    await page.getByTestId("settings-toggle").click();

    await page.getByTestId("tree-a.js").click();
    await page.getByTestId("editor").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" ");
    await page.waitForTimeout(1500); // longer than the debounce
    expect(completionRequests(), "nothing may be sent while completions are off").toBe(0);

    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("completions-toggle").check();
    await page.getByTestId("settings-toggle").click();

    await page.getByTestId("editor").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" "); // triggers a completion once typing pauses
    const ghost = page.locator(".ghost-text-decoration");
    await expect(ghost.first()).toBeVisible({ timeout: 15_000 });
    expect(completionRequests()).toBeGreaterThan(0);
    const sent = bodies.filter((b) => b.includes("<<CURSOR>>")).at(-1)!;
    expect(sent).toContain("export const answer =");

    await page.keyboard.press("Tab"); // accept: the suggestion becomes real text
    await expect(ghost).toHaveCount(0);
    await expect(page.locator(".view-lines")).toContainText("42;");
  } finally {
    srv.close();
  }
});
