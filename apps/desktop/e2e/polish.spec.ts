// Polish in the real window: themed scrollbars, a header that stays on one row, starter prompts in an empty chat, tool rows that say what
// they touched, no empty "Checks:" row in the review, and key chips on the empty editor screen.
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
const call = (id: string, name: string, args: Record<string, unknown>) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] });

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-polish-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  return dir;
}

test("scrollbars and form controls follow the theme", async () => {
  const page = await openWorkspace(workspace());
  const dark = await page.evaluate(() => ({ root: getComputedStyle(document.documentElement).colorScheme, thin: getComputedStyle(document.body).scrollbarWidth }));
  expect(dark.root).toBe("dark");
  expect(dark.thin).toBe("thin");
  // the light theme is a class on the app root; the controls inside it must switch too
  const light = await page.evaluate(() => {
    const el = document.querySelector("[data-theme]") as HTMLElement;
    el.classList.add("light");
    const scheme = getComputedStyle(el).colorScheme;
    el.classList.remove("light");
    return scheme;
  });
  expect(light).toBe("light");
});

test("the agent header keeps its mode, privacy badge and three buttons on one row", async () => {
  const page = await openWorkspace(workspace());
  const y = async (id: string) => {
    const b = await page.getByTestId(id).boundingBox();
    return b!.y + b!.height / 2;
  };
  const row = await y("mode-select");
  for (const id of ["privacy-badge", "timeline-toggle", "settings-toggle"]) expect(Math.abs((await y(id)) - row), id).toBeLessThan(6);
  expect((await page.getByTestId("agent-header").boundingBox())!.height).toBeLessThan(50);
});

test("the empty chat explains the mode and offers prompts that fill the box without sending", async () => {
  const page = await openWorkspace(workspace());
  const visible = (id: string) => page.locator(`[data-testid="${id}"]:visible`);
  await expect(visible("starters")).toContainText("only reads");
  const first = visible("starter").first();
  const text = (await first.innerText()).trim();
  await first.click();
  await expect(visible("agent-input")).toHaveValue(text);
  await expect(visible("assistant")).toHaveCount(0); // filled, not sent
  await visible("mode-select").selectOption("agent");
  await expect(visible("starters")).toContainText("waits for your review");
  expect(await visible("starter").count()).toBeGreaterThan(1);
});

test("a tool row says what it touched, the review has no empty Checks row, and the starters go once a conversation starts", async () => {
  const dir = workspace();
  let turn = 0;
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    turn++;
    if (turn === 1) res.write(sse({ choices: [{ delta: call("r1", "read_file", { path: "a.ts" }) }] }));
    else if (turn === 2) res.write(sse({ choices: [{ delta: call("e1", "edit_file", { path: "a.ts", old_string: "a = 1", new_string: "a = 2", reason: "bump" }) }] }));
    else res.write(sse({ choices: [{ delta: { content: "bumped it" } }] }));
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
    await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
    await page.locator('[data-testid="agent-input"]:visible').fill("bump a");
    await page.locator('[data-testid="agent-input"]:visible').press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("bumped it", { timeout: 30_000 });

    await expect(page.locator('[data-testid="starters"]:visible')).toHaveCount(0);
    const summaries = page.locator('[data-testid="tool-summary"]:visible');
    await expect(summaries).toHaveCount(2);
    await expect(summaries.first()).toHaveText("a.ts");

    await page.keyboard.press("Control+Shift+R");
    await expect(page.getByText("Accept all")).toBeVisible();
    await expect(page.getByTestId("review-checks")).toHaveCount(0); // nothing has been checked yet: no empty "Checks:" label
  } finally {
    srv.close();
  }
});

test("the empty editor shows its shortcuts as key chips", async () => {
  const page = await openWorkspace(workspace());
  const empty = page.getByTestId("empty-editor");
  await expect(empty).toContainText("Open a file");
  expect(await empty.locator("kbd").allInnerTexts()).toEqual(expect.arrayContaining(["Ctrl", "Shift", "R", "P"]));
});
