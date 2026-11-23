// The file tree is a single Tab stop and works from the keyboard (ARIA tree pattern).
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

test("the tree is one tab stop and the arrow keys walk, expand, collapse and open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-tree-")).replaceAll("\\", "/");
  mkdirSync(`${dir}/lib`);
  writeFileSync(`${dir}/lib/inner.ts`, "export const inner = 1;\n");
  writeFileSync(`${dir}/lib/other.ts`, "export const other = 2;\n");
  writeFileSync(`${dir}/readme.md`, "# hi\n");
  writeFileSync(`${dir}/zeta.js`, "1;\n");
  const page = await openWorkspace(dir);
  const tree = page.getByRole("tree", { name: "Files" });
  const items = tree.getByRole("treeitem");

  // Roving tabindex: exactly one row can be reached with Tab.
  await expect(items).toHaveCount(3); // lib, readme.md, zeta.js
  expect(await tree.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);

  // Down, Down moves through rows; the focused row is the one with tabindex 0.
  await page.getByTestId("tree-lib").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("tree-readme.md")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("tree-zeta.js")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("tree-lib")).toBeFocused();

  // Right expands a folder, Right again enters it, Left goes back to the parent, Left again collapses.
  await expect(page.getByTestId("tree-lib")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("tree-lib")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tree-inner.ts")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("tree-inner.ts")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("tree-lib")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("tree-lib")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("tree-inner.ts")).toHaveCount(0);

  // Enter opens the focused file.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("hi", { timeout: 20_000 });
  await expect(page.getByTestId("tree-readme.md")).toHaveAttribute("aria-selected", "true");
});
