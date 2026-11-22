// Pending changes survive a restart (simulated by reloading the window and reopening the workspace). Needs FORGE_CDP.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("pending agent edits are still there, reviewable and acceptable, after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-persist-")).replace(/\\/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\nexport const b = 2;\n");
  let n = 0;
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = { index: 0, id: "e", function: { name: "edit_file", arguments: JSON.stringify({ path: "a.js", old_string: "a = 1", new_string: "a = 100", reason: "bump a" }) } };
    res.write(sse({ choices: [{ delta: ++n === 1 ? { tool_calls: [call] } : { content: "done" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
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
    await page.getByTestId("mode-select").selectOption("agent");
    await page.getByTestId("agent-input").fill("bump a");
    await page.getByTestId("agent-input").press("Enter");
    await expect(page.getByTestId("pending-banner")).toContainText("1 file", { timeout: 20_000 });
    expect(readFileSync(`${dir}/a.js`, "utf8")).toContain("a = 1;");

    // It was saved to .forge/pending.
    await expect.poll(() => existsSync(`${dir}/.forge/pending`) && readdirSync(`${dir}/.forge/pending`).length).toBe(1);

    // "Restart": reload the window (same local storage, so the same session) and reopen the workspace.
    await page.reload();
    await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
    await page.evaluate((d) => (window as unknown as { __forge: { openFolder: (x: string) => Promise<void> } }).__forge.openFolder(d), dir);
    await expect(page.getByTestId("pending-banner")).toContainText("1 file", { timeout: 20_000 });
    expect(readFileSync(`${dir}/a.js`, "utf8")).toContain("a = 1;"); // still not on disk

    await page.getByTestId("pending-banner").click();
    await expect(page.getByTestId("hunk")).toContainText("a = 100");
    await page.getByRole("button", { name: "Explain" }).first().click();
    await expect(page.getByTestId("explain")).toContainText("bump a"); // the reason survived too
    await page.getByTestId("accept-file").click();
    await expect(page.getByTestId("review-empty")).toBeVisible();
    expect(readFileSync(`${dir}/a.js`, "utf8")).toContain("a = 100");

    // Resolved changes do not come back after another restart.
    await expect.poll(() => readFileSync(join(`${dir}/.forge/pending`, readdirSync(`${dir}/.forge/pending`)[0]!), "utf8")).toContain('"files":[]');
  } finally {
    srv.close();
  }
});
