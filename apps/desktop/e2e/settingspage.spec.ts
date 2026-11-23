// Settings as a page of its own, in the real window: it opens over the editor area (not squeezed into the agent panel), lists its sections,
// scrolls to one, closes with the button, Esc or the toggle, and the agent panel stays usable while it is open.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-settings-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  return dir;
};

test("Settings opens as a roomy page with a list of its sections, and closes three ways", async () => {
  const page = await openWorkspace(workspace());
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await page.getByTestId("settings-toggle").click();
  const settingsPage = page.getByTestId("settings-page");
  await expect(settingsPage).toBeVisible();

  // roomy: much wider than the 384-pixel agent panel it used to be squeezed into, and the same controls are in it
  const w = (await settingsPage.boundingBox())!.width;
  expect(w).toBeGreaterThan(500);
  expect(await page.getByTestId("agent-area").boundingBox().then((b) => b!.width)).toBeLessThan(w);
  await expect(page.getByTestId("settings").getByTestId("base-url")).toBeVisible();

  // the section list is read from the headings, and a click scrolls to that section
  const nav = page.getByTestId("settings-nav");
  await expect(nav).toContainText("Model");
  await expect(nav).toContainText("Claude plan");
  const names = await nav.locator("button").allInnerTexts();
  expect(names.length).toBeGreaterThan(3);
  await nav.getByRole("button", { name: names[names.length - 1]! }).click();
  await expect(page.getByTestId("settings").locator("h3").last()).toBeInViewport({ timeout: 5_000 });

  // the agent panel stays usable: the toggle closes it
  await page.getByTestId("settings-toggle").click();
  await expect(settingsPage).toHaveCount(0);

  // Close button
  await page.getByTestId("settings-toggle").click();
  await expect(settingsPage).toBeVisible();
  await page.getByTestId("settings-close").click();
  await expect(settingsPage).toHaveCount(0);

  // Esc
  await page.getByTestId("settings-toggle").click();
  await expect(settingsPage).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settingsPage).toHaveCount(0);
});

test("a change made on the Settings page takes effect, and Esc inside a drop-down does not close the page", async () => {
  const page = await openWorkspace(workspace());
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("settings").locator("select").first().selectOption("openai");
  await expect(page.getByTestId("endpoint-preset")).toBeVisible(); // content that depends on the choice appears at once
  await page.getByTestId("settings").locator("select").first().focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-page")).toBeVisible(); // Esc in a select belongs to the select
  await page.getByTestId("settings-close").click();
  // back on the main screen: the editor area is usable again and the setting stuck
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(page.getByTestId("empty-editor")).toBeVisible();
  await page.getByTestId("settings-toggle").click();
  await expect(page.getByTestId("endpoint-preset")).toBeVisible();
});
