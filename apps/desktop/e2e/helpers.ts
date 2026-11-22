import { chromium, expect, type Page } from "@playwright/test";

/**
 * Connect to the live Forge window and open `dir` as the workspace. The window persists across specs, and a
 * reload re-opens the launch workspace asynchronously, so wait for that before switching.
 */
export async function openWorkspace(dir: string): Promise<Page> {
  const browser = await chromium.connectOverCDP(process.env.FORGE_CDP!);
  const page = browser.contexts()[0]!.pages()[0]!;
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("forge.onboarded.v1", "1"); });
  await page.reload();
  await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
  const d = dir.split("\\").join("/");
  await page.evaluate((x) => (window as unknown as { __forge: { openFolder: (p: string) => Promise<void> } }).__forge.openFolder(x), d);
  await expect(page.getByTestId("status")).toContainText(d.split("/").pop()!);
  await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
  return page;
}
