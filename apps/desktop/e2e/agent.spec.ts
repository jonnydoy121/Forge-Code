// Drives the agent panel in the real Tauri window against a scripted local OpenAI-compatible server.
// Run with FORGE_CDP and FORGE_WS set (see AGENTS.md).
import { chromium, expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const cdp = process.env.FORGE_CDP;
test.skip(!cdp, "needs a running Forge window (FORGE_CDP)");

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

test("ask mode answers using read tools; request carries only read tools; privacy badge is local", async () => {
  const requests: { url: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push({ url: req.url ?? "", body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] } }] }));
      res.write(sse({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 10 } }));
    } else {
      res.write(sse({ choices: [{ delta: { content: "a.ts declares " } }] }));
      res.write(sse({ choices: [{ delta: { content: "an exported constant." } }] }));
      res.write(sse({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 12 } }));
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.connectOverCDP(cdp!);
  const page = browser.contexts()[0]!.pages()[0]!;
  try {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();
    await expect(page.getByTestId("privacy-badge")).toHaveText("local");

    await page.getByTestId("agent-input").fill("What does a.ts declare?");
    await page.getByTestId("agent-input").press("Enter");

    await expect(page.getByTestId("tool-call")).toContainText("read_file");
    await expect(page.getByTestId("assistant").last()).toContainText("an exported constant.", { timeout: 20_000 });
    await expect(page.getByTestId("token-meter")).not.toHaveText("0 tokens");

    // The model saw the read tools only (ask mode), and the tool result was fed back.
    expect(requests[0]!.body.tools.map((t: { function: { name: string } }) => t.function.name).sort()).toEqual(["grep", "ls", "read_file"]);
    expect(requests[1]!.body.messages.at(-1).role).toBe("tool");

    // Audit log records the local model request and the tool call.
    await page.getByRole("button", { name: "Audit" }).click();
    await expect(page.getByTestId("audit-log")).toContainText("(local)");
    await expect(page.getByTestId("audit-log")).toContainText("read_file");
  } finally {
    server.close();
  }
});
