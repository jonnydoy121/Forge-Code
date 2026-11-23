// "Test connection" in the real window: it asks the endpoint's /models with the typed key, shows what the server says (including a 401),
// and offers the listed models for the Model field. The mock endpoint refuses requests without the right key, like Strata does.
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

test("Test connection reports a refused key, then lists the endpoint's models once the key is right", async () => {
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
    res.setHeader("content-type", "application/json");
    if (req.url !== "/v1/models") return void res.writeHead(404).end("{}");
    if (req.headers.authorization !== "Bearer sk-mock-good") return void res.writeHead(401).end('{"error":"Invalid API key"}');
    res.end(JSON.stringify({ object: "list", data: [{ id: "swift-iq2_xs" }, { id: "big-model" }] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-endpoint-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  const key = () => page.getByTestId("settings").locator('input[type="password"]').first();
  try {
    await page.getByTestId("settings-toggle").click();
    const settings = page.getByTestId("settings");
    await settings.locator("select").first().selectOption("openai");
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);

    await page.getByTestId("endpoint-test").click();
    await expect(page.getByTestId("endpoint-result")).toContainText("401");
    await expect(page.getByTestId("endpoint-result")).toContainText("Invalid API key");
    await expect(page.getByTestId("endpoint-result")).toHaveAttribute("data-ok", "false");

    await key().fill("sk-mock-good");
    await page.getByTestId("endpoint-test").click();
    await expect(page.getByTestId("endpoint-result")).toContainText("Connected. 2 models");
    await expect(page.getByTestId("endpoint-result")).toHaveAttribute("data-ok", "true");
    await expect(page.locator("#endpoint-models option")).toHaveCount(2);
    expect(seen.at(-1)).toBe(`GET /v1/models Bearer sk-mock-good`);
    expect(seen[0]).toBe("GET /v1/models -"); // the first test went out with no key at all

    // Nothing is sent to the endpoint until the button is pressed, and the key went only to the address typed.
    expect(seen).toHaveLength(2);
  } finally {
    srv.close();
    await key().fill("").catch(() => {}); // the key field is what writes the credential store: empty it so no mock key is left behind
  }
});
