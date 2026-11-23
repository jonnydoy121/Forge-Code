// Screenshots of the real app in its main states, for design review. Writes PNGs to $FORGE_SCREENS (skipped when unset).
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

const OUT = process.env.FORGE_SCREENS;
test.skip(!process.env.FORGE_CDP || !OUT, "design-review screenshots: set FORGE_SCREENS=<folder>");
test.setTimeout(180_000);

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("capture the main screens", async () => {
  mkdirSync(OUT!, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "forge-shots-")).replace(/[\\]/g, "/");
  mkdirSync(`${dir}/src`, { recursive: true });
  mkdirSync(`${dir}/.forge/skills/release`, { recursive: true });
  writeFileSync(`${dir}/AGENTS.md`, "# Rules\n- Use TypeScript\n- Keep functions small\n");
  writeFileSync(`${dir}/.forge/skills/release/SKILL.md`, "---\ndescription: Cut a release\n---\nRun the checks, then tag.");
  writeFileSync(`${dir}/src/math.ts`, "export function add(a: number, b: number): number {\n  return a - b; // bug\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n");
  writeFileSync(`${dir}/src/index.ts`, "import { add, mul } from \"./math\";\n\nconsole.log(add(2, 3), mul(2, 3));\n");
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "demo", scripts: { test: "vitest" } }, null, 2));
  writeFileSync(`${dir}/README.md`, "# Demo\n\nA small project.\n");

  let turn = 0;
  let danger = 0;
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const c of req) body += c;
    const tools = (body.match(/"role":"tool"/g) ?? []).length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `c${++turn}`, function: { name, arguments: JSON.stringify(args) } }] });
    const delta = danger === 1 ? (danger = 2, call("run_command", { command: "rm -rf ./build" })) : tools === 0 ? call("read_file", { path: "src/math.ts" }) : tools === 1 ? call("edit_file", { path: "src/math.ts", old_string: "return a - b; // bug", new_string: "return a + b;", reason: "add should add, not subtract" }) : { content: "I fixed `add` in `src/math.ts`: it subtracted instead of adding. The change is waiting for your review." };
    res.write(sse({ choices: [{ delta }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const page = await openWorkspace(dir);
    const shot = (name: string) => page.screenshot({ path: join(OUT!, `${name}.png`) });

    await shot("01-workspace-empty-editor");

    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await shot("02-settings");
    await page.getByTestId("review-mode").selectOption("review");
    await page.getByTestId("settings-toggle").click();

    await page.getByTestId("tree-src").click(); // expand the folder
    await page.getByTestId("tree-math.ts").click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("add", { timeout: 20_000 });
    await shot("03-file-open");

    await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
    await page.locator('[data-testid="agent-input"]:visible').fill("fix the add function");
    await page.locator('[data-testid="agent-input"]:visible').press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("fixed", { timeout: 30_000 });
    await shot("04-agent-conversation");

    await expect(page.getByTestId("pending-banner")).toBeVisible();
    await page.getByTestId("pending-banner").click();
    await expect(page.getByTestId("hunk").first()).toBeVisible();
    await shot("05-review-pane");

    await page.keyboard.press("Control+Shift+P");
    await shot("06-command-palette");
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+Shift+K");
    await page.getByTestId("ctx-tab-skills").click();
    await shot("07-context-skills");
    await page.keyboard.press("Control+Shift+K");

    // The same screens in the light theme.
    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.type("theme");
    await page.keyboard.press("Enter");
    await shot("09-light-editor");
    await page.keyboard.press("Control+Shift+R");
    await expect(page.getByTestId("hunk").first()).toBeVisible();
    await shot("10-light-review");
    await page.keyboard.press("Control+Shift+R");
    await page.getByTestId("settings-toggle").click();
    await shot("11-light-settings");
    await page.getByTestId("settings-toggle").click();
    await page.keyboard.press("Control+Shift+P");
    await shot("12-light-palette");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+K");
    await page.getByTestId("ctx-tab-skills").click();
    await shot("13-light-context");
    await page.keyboard.press("Control+Shift+K");
    await page.keyboard.press("Control+Shift+L");
    await shot("14-light-plan");
    await page.keyboard.press("Control+Shift+L");
    await page.keyboard.press("Control+`");
    await page.waitForTimeout(1500);
    await shot("15-light-terminal");
    await page.keyboard.press("Control+`");

    // Tabs (one open file edited, so a dirty marker shows), the permission prompt and the welcome dialog, in light.
    await page.getByTestId("tree-index.ts").click();
    await page.getByRole("tab", { name: /math\.ts/ }).click().catch(() => page.getByText("math.ts", { exact: true }).first().click());
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.type("// edited");
    await shot("16-light-tabs");

    danger = 1;
    await page.locator('[data-testid="agent-input"]:visible').fill("clean the build folder");
    await page.locator('[data-testid="agent-input"]:visible').press("Enter");
    await expect(page.getByTestId("permission-prompt")).toBeVisible({ timeout: 30_000 });
    await shot("17-light-permission");
    await page.getByTestId("deny").click();

    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.type("welcome");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("welcome-skip")).toBeVisible();
    await shot("18-light-welcome");
    await page.getByTestId("welcome-skip").click();

    await page.getByTestId("thread-new").click();
    await shot("08-second-thread");
  } finally {
    srv.close();
  }
});
