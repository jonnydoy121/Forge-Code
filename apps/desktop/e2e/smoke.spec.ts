import { expect, test } from "@playwright/test";

test("web shell renders the empty state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("open-folder")).toBeVisible();
});
