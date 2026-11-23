// First-run and layout behaviours of the main window.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

test("opening a folder changes nothing, explains the first step, and shows the folder by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-ui-")).replaceAll("\\", "/");
  mkdirSync(`${dir}/src`);
  writeFileSync(`${dir}/AGENTS.md`, "# Rules\n- be brief\n");
  writeFileSync(`${dir}/package.json`, JSON.stringify({ scripts: { test: "vitest" } }));
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);

  // Nothing is proposed behind the user's back: no pending banner, no pending count, AGENTS.md untouched.
  await expect(page.getByTestId("pending-banner")).toHaveCount(0);
  await expect(page.getByTestId("pending-count")).toHaveCount(0);

  // The empty editor says what to do first, and goes away once a file is open.
  await expect(page.getByTestId("empty-editor")).toContainText("Open a file");
  await page.getByTestId("tree-a.ts").click();
  await expect(page.getByTestId("empty-editor")).toHaveCount(0);

  // The status bar shows the folder's name; the full path is available on hover.
  const name = dir.split("/").pop()!;
  await expect(page.getByTestId("root-name")).toHaveText(name);
  await expect(page.getByTestId("root-name")).toHaveAttribute("title", /.+/);

  // Detecting commands is still there, on request, and it is what proposes the change.
  await page.locator('[data-testid="detect-commands"]:visible').click();
  await expect(page.getByTestId("pending-banner")).toBeVisible({ timeout: 10_000 });

  // Header actions are buttons; settings are grouped under headings.
  for (const name of ["Checkpoints", "Audit", "Settings"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await page.getByTestId("settings-toggle").click();
  for (const h of ["Model", "Edits and limits", "Privacy and safety", "Assistance", "Context"]) await expect(page.getByTestId("settings").getByRole("heading", { name: h, exact: true })).toBeVisible();
});
