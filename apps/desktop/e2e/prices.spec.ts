// The cost blind spot is visible: a remote model with no price says so, and giving it one clears the warning.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

test("a remote model without a price is flagged until it is given one; local and known models are not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-price-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  await page.getByTestId("settings-toggle").click();
  const warning = page.getByTestId("unpriced-warning");

  // Local by default: nothing to count, nothing to warn about.
  await expect(warning).toHaveCount(0);
  await expect(page.getByTestId("unpriced")).toHaveCount(0);

  // A remote model the built-in table does not know.
  await page.getByTestId("main-model").fill("brand-new-model");
  await page.locator('[data-testid="settings"] select').first().selectOption("anthropic");
  await page.getByTestId("main-model").fill("brand-new-model");
  await expect(warning).toContainText("brand-new-model");
  await expect(page.getByTestId("unpriced")).toHaveText("cost not counted");

  // One the built-in table knows.
  await page.getByTestId("main-model").fill("claude-sonnet-5-5");
  await expect(warning).toHaveCount(0);

  // The user's own price clears it, and a bad line is reported by number.
  await page.getByTestId("main-model").fill("brand-new-model");
  await expect(warning).toBeVisible();
  await page.getByTestId("custom-prices").fill("brand-new-model 3 15\noops");
  await expect(warning).toHaveCount(0);
  await expect(page.getByTestId("unpriced")).toHaveCount(0);
  await expect(page.getByTestId("price-error")).toHaveText("Prices, line 2: expected: model input-price output-price");
});
