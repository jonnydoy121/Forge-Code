// Resizable panels in the real window: dragging a splitter with the mouse, the keyboard, double-click to reset, limits, and remembering the
// size after a reload.
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

const width = async (page: Page, id: string) => Math.round((await page.getByTestId(id).boundingBox())!.width);

async function drag(page: Page, id: string, dx: number) {
  const b = (await page.getByTestId(id).boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test("the explorer and the agent panel can be resized by mouse and keyboard, reset, kept within limits, and remembered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-resize-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  await page.setViewportSize({ width: 1400, height: 800 });

  // starts at the usual widths
  expect(await width(page, "explorer-pane")).toBe(240);
  expect(await width(page, "agent-area")).toBe(384);

  // mouse: dragging the explorer's bar right widens it
  await drag(page, "splitter-explorer", 80);
  expect(await width(page, "explorer-pane")).toBe(320);
  // and the agent column's bar left widens it (the panel is on the right)
  await drag(page, "splitter-agent", -100);
  expect(await width(page, "agent-area")).toBe(484);

  // limits: dragging far past them stops at the limit
  await drag(page, "splitter-explorer", -900);
  expect(await width(page, "explorer-pane")).toBe(160);
  await drag(page, "splitter-agent", 900);
  expect(await width(page, "agent-area")).toBe(300);

  // keyboard: a focusable separator with a value, arrows step it, shift steps further, Home and End jump
  const ex = page.getByTestId("splitter-explorer");
  await expect(ex).toHaveAttribute("role", "separator");
  await expect(ex).toHaveAttribute("aria-valuenow", "160");
  await ex.focus();
  await page.keyboard.press("ArrowRight");
  await expect(ex).toHaveAttribute("aria-valuenow", "176");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(ex).toHaveAttribute("aria-valuenow", "240");
  await page.keyboard.press("End");
  await expect(ex).toHaveAttribute("aria-valuenow", "480");
  await page.keyboard.press("Home");
  await expect(ex).toHaveAttribute("aria-valuenow", "160");
  const ag = page.getByTestId("splitter-agent");
  await ag.focus();
  await page.keyboard.press("ArrowLeft"); // the panel is on the right: left widens it
  await expect(ag).toHaveAttribute("aria-valuenow", "316");

  // the editor in the middle is never squeezed away
  await page.getByTestId("splitter-agent").focus();
  await page.keyboard.press("End");
  await page.getByTestId("splitter-explorer").focus();
  await page.keyboard.press("End");
  const center = await page.locator("section").first().boundingBox();
  expect(center!.width).toBeGreaterThanOrEqual(300);

  // remembered after a reload; double-click puts a panel back to its usual width
  await page.getByTestId("splitter-explorer").focus();
  await page.keyboard.press("Home");
  await page.getByTestId("splitter-explorer").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(600); // saved once dragging settles
  await page.reload();
  await expect(page.getByTestId("splitter-explorer")).toBeVisible();
  expect(await width(page, "explorer-pane")).toBe(176);
  await page.getByTestId("splitter-explorer").dblclick();
  expect(await width(page, "explorer-pane")).toBe(240);
});
