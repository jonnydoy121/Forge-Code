// "Options before code": 2-3 short approaches, a choice, and only then the agent run. Nothing is generated for the options not picked.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

interface Seen {
  body: { model: string; tools?: unknown[]; messages: { role: string; content: string }[] };
}

async function mock(replies: string[]) {
  const seen: Seen[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: replies[seen.length - 1] ?? "done" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { seen, srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1` };
}

const OPTIONS = JSON.stringify({
  options: [
    { title: "In-memory cache", summary: "Keep results in a Map inside the client.", files: ["src/api.ts"], tradeoff: "Lost on restart.", size: "small" },
    { title: "Disk cache", summary: "Persist responses to a file between runs.", files: ["src/api.ts", "src/cache.ts"], tradeoff: "More code and invalidation.", size: "large" },
    { title: "HTTP caching headers", summary: "Honour ETag and Cache-Control from the server.", files: ["src/api.ts"], tradeoff: "Needs server support.", size: "medium" },
  ],
});

async function setup(replies: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-opts-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/api.ts`, "export async function load(id: string) { return fetch(`/api/${id}`); }\n");
  const m = await mock(replies);
  const page = await openWorkspace(dir);
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("base-url").fill(m.url);
  await page.getByTestId("settings-toggle").click();
  await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
  return { page, ...m };
}

test("options come first, only the chosen one is built, and nothing is generated for the others", async () => {
  const { page, seen, srv } = await setup([OPTIONS, "implemented the disk cache"]);
  try {
    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.fill("Add caching to the API client");
    await page.getByTestId("options-button").click();

    const cards = page.getByTestId("option-card");
    await expect(cards).toHaveCount(3, { timeout: 30_000 });
    await expect(cards.nth(0)).toContainText("A. In-memory cache");
    await expect(cards.nth(1)).toContainText("B. Disk cache");
    await expect(cards.nth(1)).toContainText("Files: src/api.ts, src/cache.ts");
    await expect(cards.nth(1)).toContainText("Trade-off: More code and invalidation.");

    // So far: one model call, with no tools, asking for approaches and not code.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.tools).toBeUndefined();
    const ask = seen[0]!.body.messages.at(-1)!.content;
    expect(ask).toContain("Do NOT write code");
    expect(ask).toContain("Request: Add caching to the API client");

    // Choosing B runs the agent on B alone.
    await page.getByTestId("choose-option").nth(1).click();
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("implemented the disk cache", { timeout: 60_000 });
    expect(seen).toHaveLength(2); // the options call and the one run: nothing was generated for A or C
    expect(seen[1]!.body.tools?.length).toBeGreaterThan(0);
    const told = seen[1]!.body.messages.filter((m) => m.role === "user").at(-1)!.content;
    expect(told).toContain("Add caching to the API client");
    expect(told).toContain("Approved approach (option B: Disk cache)");
    expect(told).toContain("Files likely involved: src/api.ts, src/cache.ts");
    expect(told).toContain("Do not implement the other options");
    expect(told).not.toContain("In-memory cache");

    // The cards show what was picked and cannot be used twice.
    await expect(page.getByTestId("option-chosen")).toHaveCount(1);
    await expect(page.getByTestId("choose-option")).toHaveCount(0);
    await expect(cards.nth(1)).toContainText("Chosen");
  } finally {
    srv.close();
  }
});

test("a reply with no usable options puts the request back in the box instead of losing it; Ask mode has nothing to choose between", async () => {
  const { page, seen, srv } = await setup(["I think caching is a good idea.", "second"]);
  try {
    const input = page.locator('[data-testid="agent-input"]:visible');
    await expect(page.getByTestId("options-button")).toBeDisabled(); // nothing typed yet
    await input.fill("Add caching to the API client");
    await page.getByTestId("options-button").click();
    await expect(page.getByTestId("notice").filter({ hasText: "did not return usable options" })).toBeVisible({ timeout: 30_000 });
    await expect(input).toHaveValue("Add caching to the API client");
    await expect(page.getByTestId("option-card")).toHaveCount(0);
    expect(seen).toHaveLength(1);

    await page.locator('[data-testid="mode-select"]:visible').selectOption("ask");
    await expect(page.getByTestId("options-button")).toBeDisabled();
    await page.locator('[data-testid="mode-select"]:visible').selectOption("plan");
    await expect(page.getByTestId("options-button")).toBeEnabled();
  } finally {
    srv.close();
  }
});
