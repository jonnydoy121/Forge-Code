// If the shared agent process dies, the next message starts a fresh one and the conversation carries over.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, runtimeProcesses } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("a crashed agent process is replaced on the next message, with the conversation carried over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-recover-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  const bodies: string[] = [];
  let n = 0;
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: `reply ${++n}` } }] }));
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
    const lastAnswer = page.locator('[data-testid="assistant"]:visible').last();

    await input.fill("first question");
    await input.press("Enter");
    await expect(lastAnswer).toContainText("reply 1", { timeout: 20_000 });
    expect(runtimeProcesses()).toBe(1);

    execFileSync("taskkill", ["/IM", "forge-runtime.exe", "/F"], { stdio: "ignore" }); // the agent process crashes
    await expect.poll(runtimeProcesses, { timeout: 10_000 }).toBe(0);

    await input.fill("second question");
    await input.press("Enter");
    await expect(lastAnswer).toContainText("reply 2", { timeout: 30_000 });
    expect(bodies.at(-1)).toContain("first question"); // the earlier conversation went into the new session
    expect(runtimeProcesses()).toBe(1);
  } finally {
    srv.close();
  }
});
