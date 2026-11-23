// The trimmed Monaco build (src/lib/monaco-features.ts) must still do what this app relies on.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const FILES: Record<string, string> = {
  "a.ts": "export function add(a: number, b: number): number {\n  // sum\n  return a + b;\n}\n",
  "b.js": "const x = 'text';\nfunction f() { return x.length; }\n",
  "c.py": "def add(a, b):\n    # sum\n    return a + b\n",
  "d.css": ".box { color: red; margin: 0 auto; }\n",
  "e.html": "<div class=\"box\"><p>hello</p></div>\n",
  "f.json": "{ \"name\": \"forge\", \"count\": 3, \"ok\": true }\n",
  "g.rs": "fn main() { let x: i32 = 5; println!(\"{}\", x); }\n",
  "h.txt": "just some plain words here\n",
};

/** The distinct syntax-colour classes on the visible text: more than one means a tokenizer is working. */
const tokenClasses = (page: import("@playwright/test").Page) =>
  page.evaluate(() => [...new Set([...document.querySelectorAll(".monaco-editor .view-line span span")].map((e) => e.className).filter((c) => /^mtk\d+/.test(c)))]);

test("syntax colouring works for every kind of file, including the languages whose services were left out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-monaco-")).replace(/[\\]/g, "/");
  for (const [name, text] of Object.entries(FILES)) writeFileSync(`${dir}/${name}`, text);
  const page = await openWorkspace(dir);
  for (const name of Object.keys(FILES).filter((n) => n !== "h.txt")) {
    await page.getByTestId(`tree-${name}`).click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText(FILES[name]!.split("\n")[0]!.slice(0, 6), { timeout: 20_000 });
    await expect.poll(async () => (await tokenClasses(page)).length, { message: `${name} should be syntax coloured`, timeout: 15_000 }).toBeGreaterThan(1);
  }
  // Plain text has nothing to colour: the check above is meaningful because this one stays at a single class.
  await page.getByTestId("tree-h.txt").click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("plain words", { timeout: 20_000 });
  expect((await tokenClasses(page)).length).toBe(1);
});

test("the editor's own find widget and command palette still work, and our AI action is in the palette", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-monaco2-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.ts`, "const needle = 1;\nconst hay = needle + 2;\n");
  const page = await openWorkspace(dir);
  await page.getByTestId("tree-a.ts").click();
  await page.getByTestId("editor").click();

  await page.keyboard.press("Control+f");
  await expect(page.locator(".monaco-editor .find-widget.visible")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type("needle");
  await expect(page.locator(".monaco-editor .find-widget .matchesCount")).toContainText("1 of 2");
  await page.keyboard.press("Escape");

  await page.getByTestId("editor").click();
  await page.keyboard.press("F1");
  await expect(page.locator(".quick-input-widget")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type("Edit selection");
  await expect(page.locator(".quick-input-widget")).toContainText("Forge-Code: Edit selection with AI");
  await page.keyboard.press("Escape");
});
