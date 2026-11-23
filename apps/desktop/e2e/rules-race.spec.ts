// The rules panel loads its list asynchronously every time the active file changes. When loads overlap, an older one that finishes
// last must not overwrite a newer one: once things settle, the list has to match the file that is active now. Here the active file is
// switched back and forth as fast as the page allows, so many loads overlap, and the list is checked each time after it settles.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(180_000);

test("however fast the active file changes, the rules shown settle on the rules of the file that is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-race-")).replaceAll("\\", "/");
  for (const d of ["src/components", "server", ".forge/rules"]) mkdirSync(`${dir}/${d}`, { recursive: true });
  writeFileSync(`${dir}/AGENTS.md`, "# Rules\n\nROOT-RULE: use pnpm\n");
  writeFileSync(`${dir}/.forge/rules/react.md`, '---\ndescription: React component conventions\nglobs: ["src/components/**/*.tsx"]\nactivation: auto\n---\nREACT-RULE: function components only\n');
  writeFileSync(`${dir}/src/components/Button.tsx`, "export default function Button() {\n  return null;\n}\n");
  writeFileSync(`${dir}/server/api.ts`, "export const api = 1;\n");
  writeFileSync(`${dir}/server/AGENTS.md`, "SERVER-RULE: validate all input\n");
  const page = await openWorkspace(dir);

  // Two files open, so a click on a tab changes the active file without leaving the Context view.
  await page.getByTestId("tree-server").click();
  await page.getByTestId("tree-api.ts").click();
  await page.getByTestId("tree-src").click();
  await page.getByTestId("tree-components").click();
  await page.getByTestId("tree-Button.tsx").click();
  const api = page.getByRole("tab", { name: /api\.ts/ });
  const button = page.getByRole("tab", { name: /Button\.tsx/ });
  await page.keyboard.press("Control+Shift+K");
  await expect(page.getByTestId("context-pane")).toBeVisible();

  const list = page.getByTestId("rule-list");
  const react = page.getByTestId("rule").filter({ hasText: "react" });
  const server = page.getByTestId("rule").filter({ hasText: "server/AGENTS.md" });

  // Switch tabs a few milliseconds apart, in the page itself: each switch renders (so it starts a load) while earlier loads are still
  // running. Clicks fired in one synchronous burst would be batched by React into a single change and overlap nothing.
  const flurry = (last: "api" | "button") =>
    page.evaluate(
      async ({ last }) => {
        const tabs = [...document.querySelectorAll('[role="tab"]')] as HTMLElement[];
        const a = tabs.find((t) => /api\.ts/.test(t.textContent ?? ""))!;
        const b = tabs.find((t) => /Button\.tsx/.test(t.textContent ?? ""))!;
        const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 40; i++) {
          (i % 2 === 0 ? a : b).click();
          await pause(i % 3); // 0-2 ms: a macrotask each, so React commits every switch
        }
        (last === "api" ? a : b).click();
      },
      { last },
    );

  for (let round = 0; round < 25; round++) {
    const endOn = round % 2 === 0 ? "button" : "api";
    await flurry(endOn);
    await page.waitForTimeout(400); // let every load finish
    if (endOn === "button") {
      await expect(react, `round ${round}: Button.tsx is active, so the react rule applies`).toHaveCount(1);
      await expect(server, `round ${round}: and the server rule does not`).toHaveCount(0);
    } else {
      await expect(server, `round ${round}: api.ts is active, so the server rule applies`).toHaveCount(1);
      await expect(react, `round ${round}: and the react rule does not`).toHaveCount(0);
    }
  }
  await expect(list).toContainText("ROOT-RULE"); // the always-on rule never went away
  void api;
  void button;
});
