// File-type icons in the real explorer: each kind of file gets its own glyph (so kinds differ by shape, not only colour), and folders that
// hold generated or vendored files are dimmed.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

test("the explorer shows a different icon for code, data, docs, tests, config and locks, and dims folders of generated files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-icons-")).replaceAll("\\", "/");
  const files: Record<string, string> = {
    "app.ts": "x", "data.json": "{}", "README.md": "#", "app.test.ts": "x", "package.json": "{}", "yarn.lock": "", "run.sh": "echo", "site.css": "a{}", "LICENSE": "mit",
  };
  for (const [n, c] of Object.entries(files)) writeFileSync(`${dir}/${n}`, c);
  mkdirSync(`${dir}/coverage/lcov`, { recursive: true });
  mkdirSync(`${dir}/src`, { recursive: true });
  const page = await openWorkspace(dir);
  const kind = async (name: string) => page.getByTestId(`tree-${name}`).locator("svg[data-file-kind]").getAttribute("data-file-kind");
  expect(await kind("app.ts")).toBe("code");
  expect(await kind("data.json")).toBe("data");
  expect(await kind("README.md")).toBe("doc");
  expect(await kind("app.test.ts")).toBe("test");
  expect(await kind("package.json")).toBe("config");
  expect(await kind("yarn.lock")).toBe("lock");
  expect(await kind("run.sh")).toBe("shell");
  expect(await kind("site.css")).toBe("style");
  expect(await kind("LICENSE")).toBe("generic");
  await expect(page.getByTestId("tree-coverage").locator("svg[data-folder-kind]")).toHaveAttribute("data-folder-kind", "dimmed");
  await expect(page.getByTestId("tree-src").locator("svg[data-folder-kind]")).toHaveAttribute("data-folder-kind", "normal");

  // different kinds really draw different glyphs, not just different attributes
  const glyph = (name: string) => page.getByTestId(`tree-${name}`).locator("svg g").innerHTML();
  const drawn = new Set([await glyph("app.ts"), await glyph("data.json"), await glyph("README.md"), await glyph("package.json"), await glyph("yarn.lock"), await glyph("run.sh")]);
  expect(drawn.size).toBe(6);
});
