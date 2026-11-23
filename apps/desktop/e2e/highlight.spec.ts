// Syntax colours in chat code blocks, in the real window: keywords, strings and comments are coloured from the editor's tokenizer, an unknown
// language stays plain, the text of the block is unchanged (so Copy copies what the model wrote), and markup in a block stays inert text.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const TS = 'export const greeting = "hello"; // say hi\nexport function add(a: number): number { return a + 1; }';
const HTML = '<div onclick="alert(1)"><img src=x onerror="alert(2)"></div>';
const REPLY = ["Here is the code:", "```ts", TS, "```", "An unknown language:", "```klingon", "qapla' 42", "```", "And some markup:", "```html", HTML, "```"].join("\n");

test("code blocks are coloured from the editor's tokenizer, unknown languages stay plain, and markup stays text", async () => {
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: REPLY } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-hl-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();
    await page.locator('[data-testid="agent-input"]:visible').fill("show me code");
    await page.locator('[data-testid="agent-input"]:visible').press("Enter");
    const blocks = page.locator('[data-testid="code-block"]:visible');
    await expect(blocks).toHaveCount(3, { timeout: 30_000 });

    // TypeScript: coloured (the first use loads the editor engine and the language, so allow a moment)
    const ts = blocks.nth(0).locator("code");
    await expect(ts).toHaveAttribute("data-highlighted", "true", { timeout: 30_000 });
    await expect(ts.locator(".tok-keyword").first()).toHaveText("export");
    await expect(ts.locator(".tok-string").first()).toContainText("hello");
    await expect(ts.locator(".tok-comment").first()).toContainText("say hi");
    expect((await ts.innerText()).replace(/\r/g, "")).toBe(TS); // exactly what the model wrote

    // unknown language: plain
    const klingon = blocks.nth(1).locator("code");
    await expect(klingon).toHaveText("qapla' 42");
    expect(await klingon.getAttribute("data-highlighted")).toBeNull();
    await expect(klingon.locator("span")).toHaveCount(0);

    // markup: shown as text, never turned into elements
    const html = blocks.nth(2).locator("code");
    await expect(html).toHaveAttribute("data-highlighted", "true", { timeout: 30_000 });
    expect((await html.innerText()).replace(/\r/g, "")).toBe(HTML);
    await expect(html.locator("img, div")).toHaveCount(0); // no elements were created from the text
    await expect(page.locator("[data-testid=messages] img")).toHaveCount(0);
  } finally {
    srv.close();
  }
});
