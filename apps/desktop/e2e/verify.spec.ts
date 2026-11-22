// Phase 5 in the real window: the agent fixes a seeded failing test through the verify-fix loop (wrong fix,
// weakening attempt, real fix), and execute-class tools ask the developer first. Needs FORGE_CDP.
import { chromium, expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cdp = process.env.FORGE_CDP;
test.skip(!cdp, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ index: 0, id, function: { name, arguments: JSON.stringify(args) } });

const TEST_FILE = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "./sum.js";',
  'test("adds small numbers", () => {',
  "  assert.equal(add(1, 2), 3);",
  "  assert.equal(add(2, 3), 5);",
  "});",
  "",
].join("\n");

function project() {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-proj-")).replace(/\\/g, "/");
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, '{"type":"module","scripts":{"test":"node --test"}}');
  writeFileSync(`${dir}/sum.js`, "export function add(a, b) {\n  return a - b;\n}\n");
  writeFileSync(`${dir}/sum.test.js`, TEST_FILE);
  writeFileSync(`${dir}/AGENTS.md`, "# Rules\n\n## Commands\n- test: node --test\n- test:file: node --test {file}\n");
  return dir;
}

async function scriptedServer(turns: object[][]) {
  const requests: unknown[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const t = turns.shift() ?? [{ content: "done" }];
    for (const delta of t) res.write(sse({ choices: [{ delta }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

async function setup(port: number, dir: string, reviewMode: "auto" | "review") {
  const browser = await chromium.connectOverCDP(cdp!);
  const page = browser.contexts()[0]!.pages()[0]!;
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // After a reload the app re-opens the launch workspace asynchronously; let that finish before switching,
  // otherwise it would overwrite the project we are about to open.
  await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
  await page.evaluate((d) => (window as unknown as { __forge: { openFolder: (x: string) => Promise<void> } }).__forge.openFolder(d), dir);
  await expect(page.getByTestId("status")).toContainText(dir.split("/").pop()!);
  await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
  await page.getByTestId("review-mode").selectOption(reviewMode);
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("mode-select").selectOption("agent");
  return page;
}

test("agent fixes a failing test via the verify-fix loop without weakening it", async () => {
  const dir = project();
  const edit = (id: string, path: string, from: string, to: string) => [{ tool_calls: [toolCall(id, "edit_file", { path, old_string: from, new_string: to, reason: id })] }];
  const { server, port, requests } = await scriptedServer([
    edit("wrong", "sum.js", "a - b", "a * b"),
    edit("weaken", "sum.test.js", "  assert.equal(add(1, 2), 3);\n", ""),
    edit("fix", "sum.js", "a * b", "a + b"),
    [{ content: "Fixed: add now adds." }],
  ]);
  try {
    const page = await setup(port, dir, "auto");
    await page.getByTestId("agent-input").fill("make the tests pass");
    await page.getByTestId("agent-input").press("Enter");

    // wrong fix -> failing report card; real fix -> passing; final full run -> Verified
    await expect(page.getByTestId("report-label").filter({ hasText: /^Verified$/ })).toBeVisible({ timeout: 90_000 });
    const labels = await page.getByTestId("report-label").allTextContents();
    expect(labels).toContain("Checks failed");
    expect(labels.at(-1)).toBe("Verified");

    expect(readFileSync(`${dir}/sum.js`, "utf8")).toContain("a + b");
    expect(readFileSync(`${dir}/sum.test.js`, "utf8")).toBe(TEST_FILE); // never weakened

    // The failure reached the model as structured errors; the weakening attempt was flagged.
    const bodies = JSON.stringify(requests);
    expect(bodies).toContain("attempt 1 of 5");
    expect(bodies).toContain("adds small numbers");
    expect(bodies).toContain("FLAGGED");

    // The flagged edit waits for the developer, with a visible warning and no auto-apply.
    await expect(page.getByTestId("pending-banner")).toContainText("1 file");
    await page.getByTestId("pending-banner").click();
    await expect(page.getByTestId("file-warning")).toContainText("removes 1 assertion");
  } finally {
    server.close();
  }
});

test("execute-class tools ask first; deny blocks them; allow-once runs the project's checks", async () => {
  const dir = project();
  const { server, port } = await scriptedServer([
    [{ tool_calls: [toolCall("c1", "run_checks", { scope: "full" })] }],
    [{ content: "denied, stopping" }],
    [{ tool_calls: [toolCall("c2", "run_checks", { scope: "full" })] }],
    [{ content: "saw the failure" }],
  ]);
  try {
    const page = await setup(port, dir, "auto");
    await page.getByTestId("agent-input").fill("run the checks");
    await page.getByTestId("agent-input").press("Enter");
    await expect(page.getByTestId("permission-prompt")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("deny").click();
    await expect(page.getByTestId("tool-call").first()).toContainText("run_checks");
    await expect(page.getByTestId("assistant").last()).toContainText("denied, stopping", { timeout: 20_000 });
    await page.getByTestId("tool-call").first().click();
    await expect(page.getByTestId("tool-call").first()).toContainText("permission denied");

    await page.getByTestId("agent-input").fill("try again");
    await page.getByTestId("agent-input").press("Enter");
    await expect(page.getByTestId("permission-prompt")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("allow-once").click();
    await expect(page.getByTestId("assistant").last()).toContainText("saw the failure", { timeout: 60_000 });
    await expect(page.getByTestId("tool-call").last()).toContainText("run_checks");
  } finally {
    server.close();
  }
});

test("Run checks button shows a report card with structured failures", async () => {
  const dir = project();
  const { server, port } = await scriptedServer([]);
  try {
    const page = await setup(port, dir, "review");
    await page.getByTestId("run-checks").click();
    const card = page.getByTestId("report-card").last();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByTestId("report-label")).toHaveText("Checks failed");
    await expect(card).toContainText("sum.test.js");
    await expect(card).toContainText("adds small numbers");
    await expect(card.getByTestId("report-unverified")).toContainText("no lint command configured");
  } finally {
    server.close();
  }
});
