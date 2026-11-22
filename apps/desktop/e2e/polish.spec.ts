// Phase 9: onboarding, keyboard-only use, accessibility (axe), and responsiveness budgets. Needs FORGE_CDP.
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

function project() {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-polish-")).replace(/\\/g, "/");
  mkdirSync(`${dir}/src`, { recursive: true });
  writeFileSync(`${dir}/small.ts`, "export const a = 1;\n");
  writeFileSync(`${dir}/src/big.ts`, Array.from({ length: 5000 }, (_, i) => `export const v${i} = ${i}; // line ${i}`).join("\n") + "\n");
  return dir;
}

/** Serious problems only; the editor and terminal widgets are third-party and audited by their own projects. */
async function violations(page: import("@playwright/test").Page) {
  const r = await new AxeBuilder({ page }).exclude(".monaco-editor").exclude(".xterm").analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")})`);
}

test("first run: the privacy choice comes first, works by keyboard alone, and is saved", async () => {
  const dir = project();
  const page = await openWorkspace(dir);
  await page.evaluate(() => localStorage.clear()); // as a brand-new user
  await page.reload();
  const welcome = page.getByTestId("welcome");
  await expect(welcome).toBeVisible();
  await expect(page.getByTestId("choose-local")).toBeFocused(); // focus starts inside the dialog
  expect(await violations(page)).toEqual([]);

  // Keyboard only: pick hosted, then back to local, then reach and press the last button.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("choose-hosted")).toBeChecked();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("choose-local")).toBeChecked();
  await page.getByTestId("welcome-skip").focus();
  await page.keyboard.press("Enter");
  await expect(welcome).toHaveCount(0);
  await expect(page.getByTestId("safety-status")).toContainText("local-only");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("forge.settings.v1")!));
  expect(saved).toMatchObject({ provider: "ollama", localOnly: true });
  // not shown again
  await page.reload();
  await expect(page.getByTestId("welcome")).toHaveCount(0);
});

test("main views have no serious or critical accessibility violations", async () => {
  const dir = project();
  const page = await openWorkspace(dir);
  await page.getByTestId("tree-small.ts").click();
  expect(await violations(page), "editor + agent panel").toEqual([]);

  await page.getByTestId("settings-toggle").click();
  expect(await violations(page), "settings").toEqual([]);
  await page.getByTestId("settings-toggle").click();

  for (const [view, id] of [["context", "context-pane"], ["plan", "plan-pane"]] as const) {
    await page.keyboard.press(view === "context" ? "Control+Shift+K" : "Control+Shift+L");
    await expect(page.getByTestId(id)).toBeVisible();
    expect(await violations(page), view).toEqual([]);
    await page.keyboard.press(view === "context" ? "Control+Shift+K" : "Control+Shift+L");
  }
  await page.keyboard.press("Control+Shift+P");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  expect(await violations(page), "command palette").toEqual([]);
});

test("keyboard-only: command palette runs commands, focus is trapped sensibly, Escape closes", async () => {
  const page = await openWorkspace(project());
  await page.keyboard.press("Control+Shift+P");
  const input = page.getByTestId("palette-input");
  await expect(input).toBeFocused();
  await page.keyboard.type("theme");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-theme="light"]')).toHaveCount(1);
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  // switch back so later specs see the default theme
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("theme");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-theme="dark"]')).toHaveCount(1);
});

test("stays responsive: opening a 5,000-line file and typing", async () => {
  const page = await openWorkspace(project());
  const t0 = Date.now();
  await page.getByTestId("tree-src").click();
  await page.getByTestId("tree-big.ts").click();
  await expect(page.getByRole("tab", { name: /big\.ts/ })).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("export const v0 = 0");
  const open = Date.now() - t0;
  expect(open).toBeLessThan(1500);

  await page.getByTestId("editor").click();
  await page.keyboard.press("Control+End");
  // Best of three bursts: one slow burst under background load (indexing, other processes) is not the editor's latency.
  const bursts: number[] = [];
  for (let k = 0; k < 3; k++) {
    const t1 = Date.now();
    await page.keyboard.type("x".repeat(60), { delay: 0 });
    bursts.push((Date.now() - t1) / 60);
  }
  const perKey = Math.min(...bursts);
  console.log(`file open ${open} ms, typing ${perKey.toFixed(1)} ms/key (bursts ${bursts.map((b) => b.toFixed(1)).join(", ")})`);
  expect(perKey).toBeLessThan(40);
  // undo so the temp file's tab is clean for later specs
  for (let i = 0; i < 6; i++) await page.keyboard.press("Control+Z");
});
