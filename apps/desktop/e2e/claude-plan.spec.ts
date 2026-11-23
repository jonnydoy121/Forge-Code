// Claude through the developer's own Claude plan (no API key): offered when Claude Code is signed in, honest about where code goes.
// It asks the real `claude auth status` on this machine and expects the app to agree with it.
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

function realClaude(): "signed-in" | "signed-out" | "missing" {
  const r = spawnSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 30_000, shell: process.platform === "win32" });
  if (r.error || (r.status !== 0 && !String(r.stdout).trim().startsWith("{"))) return "missing";
  try {
    return (JSON.parse(String(r.stdout)) as { loggedIn?: boolean }).loggedIn === true ? "signed-in" : "signed-out";
  } catch {
    return "missing";
  }
}

test("Claude plan is offered exactly when Claude Code is signed in, says where code goes, and hides in local-only mode", async () => {
  const state = realClaude();
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-claude-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  const mode = page.locator('[data-testid="mode-select"]:visible');
  const option = mode.locator("option", { hasText: "Claude plan" });

  await page.getByTestId("settings-toggle").click();
  const status = page.getByTestId("claude-status");
  if (state === "signed-in") await expect(status).toContainText("Signed in with your Claude plan", { timeout: 30_000 });
  else if (state === "signed-out") await expect(status).toContainText("not signed in", { timeout: 30_000 });
  else await expect(status).toContainText("not installed", { timeout: 30_000 });
  await expect(option).toHaveCount(state === "signed-in" ? 1 : 0);

  if (state !== "signed-in") return; // nothing more to check on a machine without a Claude login

  // The longer entry must not widen the agent header past the panel: every header button stays inside the window (it once pushed Settings off-screen).
  const vw = page.viewportSize()?.width ?? (await page.evaluate(() => window.innerWidth));
  for (const id of ["timeline-toggle", "settings-toggle"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.x + box!.width, `${id} right edge`).toBeLessThanOrEqual(vw);
  }

  // Selecting it is honest about where code goes (nothing is sent: no message is typed).
  await mode.selectOption({ label: "Claude plan" });
  await expect(page.getByTestId("privacy-badge")).toHaveText("remote");
  await expect(page.getByTestId("privacy-badge")).toHaveAttribute("title", /Anthropic/);

  // Local-only mode hides it, and drops the selection back to a normal mode.
  await page.getByTestId("local-only").check();
  await expect(option).toHaveCount(0);
  await expect(status).toContainText("Local-only mode");
  await expect(mode).not.toHaveValue("ext:claude");
  await page.getByTestId("local-only").uncheck();
  await expect(option).toHaveCount(1);

  // "Check again" asks again.
  await page.getByTestId("claude-recheck").click();
  await expect(status).toContainText("Signed in with your Claude plan", { timeout: 30_000 });
});
