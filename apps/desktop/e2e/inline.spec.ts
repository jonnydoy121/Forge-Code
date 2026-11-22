// Inline edit: select code, describe the change (Alt+I), and the result arrives as a reviewable pending change.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("Alt+I edits the selection through the model and proposes it for review without touching the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-inline-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\nexport const b = 2;\n");
  const prompts: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    prompts.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "```js\nexport const total = 2;\n```" } }] }));
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

    await page.getByTestId("tree-a.js").click();
    await page.getByTestId("editor").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End"); // select line 2: "export const b = 2;"
    await page.keyboard.press("Alt+i");

    await expect(page.getByTestId("inline-edit")).toBeVisible();
    await page.getByTestId("inline-instruction").fill("rename b to total");
    await page.getByTestId("inline-instruction").press("Enter");
    await expect(page.getByTestId("inline-done")).toContainText("Proposed", { timeout: 20_000 });

    // The model saw the selection and the instruction, not a request for tools.
    const sent = JSON.parse(prompts.at(-1)!) as { messages: { content: string }[]; tools?: unknown };
    expect(sent.messages.at(-1)!.content).toContain("<<SELECTION>>export const b = 2;<</SELECTION>>");
    expect(sent.messages.at(-1)!.content).toContain("rename b to total");
    expect(sent.tools).toBeUndefined();

    // Nothing written yet; the change is pending and reviewable like any agent edit.
    expect(readFileSync(`${dir}/a.js`, "utf8")).toBe("export const a = 1;\nexport const b = 2;\n");
    await expect(page.getByTestId("pending-banner")).toContainText("1 file");
    await page.getByTestId("pending-banner").click();
    await expect(page.getByTestId("hunk")).toContainText("export const total = 2;");
    await page.getByTestId("accept-file").click();
    await expect(page.getByTestId("review-empty")).toBeVisible();
    expect(readFileSync(`${dir}/a.js`, "utf8")).toBe("export const a = 1;\nexport const total = 2;\n");
  } finally {
    srv.close();
  }
});
