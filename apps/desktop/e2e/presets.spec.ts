// Endpoint presets in the real window: choosing one fills the URL and a suggested model, and clears the shared API key so that a key
// for one service is never carried to another (the key is stored once for all OpenAI-compatible endpoints).
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

test("choosing an endpoint preset fills the URL and model and clears the stored key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-preset-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  await page.getByTestId("settings-toggle").click();
  const settings = page.getByTestId("settings");
  await settings.locator("select").first().selectOption("openai");

  const key = settings.locator('input[type="password"]').first();
  await key.fill("sk-openai-secret");
  await expect(key).toHaveValue("sk-openai-secret");

  await page.getByTestId("endpoint-preset").selectOption("gemini");
  await expect(page.getByTestId("base-url")).toHaveValue("https://generativelanguage.googleapis.com/v1beta/openai");
  await expect(page.getByTestId("main-model")).toHaveValue("gemini-2.0-flash");
  await expect(key).toHaveValue(""); // the OpenAI key did not follow us to Google

  // It is gone from the credential store too, not just from the field: it does not come back after a reload.
  await page.reload();
  await page.getByTestId("settings-toggle").click();
  await expect(page.getByTestId("endpoint-preset")).toHaveValue("gemini"); // the choice itself was saved
  await expect(page.getByTestId("settings").locator('input[type="password"]').first()).toHaveValue("");

  // A hand-typed URL shows as custom, and picking OpenAI goes back to the default address.
  await page.getByTestId("base-url").fill("http://example.test/v1");
  await expect(page.getByTestId("endpoint-preset")).toHaveValue("custom");
  await page.getByTestId("endpoint-preset").selectOption("openai");
  await expect(page.getByTestId("base-url")).toHaveValue("");
  await expect(page.getByTestId("main-model")).toHaveValue("gpt-4o");
});
