// Drives the real Tauri window over WebView2's remote-debugging port.
// Run with: FORGE_CDP=http://127.0.0.1:9222 FORGE_WS=<workspace dir> npm run e2e
import { chromium, expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cdp = process.env.FORGE_CDP;
const ws = process.env.FORGE_WS ?? "";
test.skip(!cdp, "needs a running Forge window (FORGE_CDP)");

test("editor core flow in the real app", async () => {
  const browser = await chromium.connectOverCDP(cdp!);
  const page = browser.contexts()[0]!.pages()[0]!;

  // File tree -> tab -> LSP diagnostics
  await page.getByTestId("tree-a.ts").click();
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toBeVisible();
  await expect(page.getByTestId("lsp-status")).toContainText(/1 errors/, { timeout: 60_000 });

  // Edit marks the tab dirty; Ctrl+S saves to disk
  await page.getByTestId("editor").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nexport const saved = 1;");
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toContainText("●");
  await page.keyboard.press("Control+S");
  await expect(page.getByRole("tab", { name: /a\.ts/ })).not.toContainText("●");
  expect(readFileSync(join(ws, "a.ts"), "utf8")).toContain("export const saved = 1;");

  // Python diagnostics
  await page.getByTestId("tree-b.py").click();
  await expect(page.getByTestId("lsp-status")).toContainText(/1 errors/, { timeout: 60_000 });

  // Command palette
  await page.keyboard.press("Control+Shift+P");
  await page.getByTestId("palette-input").fill("toggle term");
  await page.keyboard.press("Enter");

  // Integrated terminal runs a real command
  const term = page.getByTestId("terminal");
  await expect(term).toBeVisible();
  await term.click();
  await page.keyboard.type("echo forge-$((6*7))\r".replace("$((6*7))", "42"));
  await expect(term).toContainText("forge-42", { timeout: 20_000 });
});
