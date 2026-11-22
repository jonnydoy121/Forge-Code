// Saved prompts: .forge/prompts/<name>.md invoked as /name with autocomplete and $ARGUMENTS.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("typing / suggests saved prompts, and the model receives the expanded text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-prompts-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  mkdirSync(`${dir}/.forge/prompts`, { recursive: true });
  writeFileSync(`${dir}/.forge/prompts/review.md`, "---\ndescription: Review a file for bugs\n---\nReview $ARGUMENTS for bugs. Be concise.\n");
  writeFileSync(`${dir}/.forge/prompts/explain.md`, "# Explain this code\nExplain the code step by step.\n");
  const bodies: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "looks fine" } }] }));
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

    await input.fill("/");
    await expect(page.getByTestId("prompt-suggestions")).toBeVisible();
    await expect(page.getByTestId("prompt-review")).toContainText("Review a file for bugs");
    await expect(page.getByTestId("prompt-explain")).toContainText("Explain this code"); // first line when no description

    await input.fill("/rev");
    await expect(page.getByTestId("prompt-explain")).toHaveCount(0); // filtered
    await input.press("Tab"); // completes the first match
    await expect(input).toHaveValue("/review ");

    await input.pressSequentially("a.js");
    await input.press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("looks fine", { timeout: 20_000 });
    const sent = bodies.at(-1)!;
    expect(sent).toContain("Review a.js for bugs. Be concise.");
    expect(sent).not.toContain("/review");

    // An unknown slash command is just text.
    await input.fill("/nosuch thing");
    await expect(page.getByTestId("prompt-suggestions")).toHaveCount(0);
  } finally {
    srv.close();
  }
});
