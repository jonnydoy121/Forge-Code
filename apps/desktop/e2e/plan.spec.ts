// Phase 6 in the real window. Needs FORGE_CDP.
import { chromium, expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cdp = process.env.FORGE_CDP;
test.skip(!cdp, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ index: 0, id, function: { name, arguments: JSON.stringify(args) } });

const PLAN = [
  "---",
  "title: Add greeting",
  "status: draft",
  "---",
  "# Add greeting",
  "",
  "## Goal",
  "The app can greet a user by name.",
  "",
  "## Assumptions",
  "- English only.",
  "",
  "## Files to change",
  "- `greet.js` — add the greeting",
  "",
  "## Files to create",
  "- `greet.test.js` — tests",
  "",
  "## Tasks",
  "1. [ ] **Add greet()** — acceptance: greet('Ada') returns 'Hello, Ada'",
  "   - files: greet.js",
  "2. [ ] **Add tests** — acceptance: tests exist",
  "   - files: greet.test.js",
  "",
  "## Risks",
  "- Name collisions.",
  "",
  "## Out of scope",
  "- Localisation",
  "",
].join("\n");

function project() {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-plan-")).replace(/\\/g, "/");
  writeFileSync(`${dir}/greet.js`, "export const greet = (n) => n;\n");
  writeFileSync(`${dir}/other.js`, "export const keep = 1;\n");
  return dir;
}

async function scripted(turns: object[][]) {
  const requests: { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const delta of turns.shift() ?? [{ content: "done" }]) res.write(sse({ choices: [{ delta }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

async function open(port: number, dir: string) {
  const browser = await chromium.connectOverCDP(cdp!);
  const page = browser.contexts()[0]!.pages()[0]!;
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
  await page.evaluate((d) => (window as unknown as { __forge: { openFolder: (x: string) => Promise<void> } }).__forge.openFolder(d), dir);
  await expect(page.getByTestId("status")).toContainText(dir.split("/").pop()!);
  await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
  await page.getByTestId("review-mode").selectOption("auto");
  await page.getByTestId("settings-toggle").click();
  return page;
}

test("Plan mode asks, writes only the plan; Build runs it step by step; out-of-plan edits are blocked", async () => {
  const dir = project();
  const { server, port, requests } = await scripted([
    // --- plan mode ---
    [{ tool_calls: [toolCall("q", "ask_user", { questions: [{ question: "Which language?", default: "English" }] })] }],
    [{ tool_calls: [toolCall("w", "write_plan", { markdown: PLAN })] }],
    [{ content: "Plan written. Please review it before building." }],
    // --- build step 1 ---
    [{ tool_calls: [toolCall("e1", "edit_file", { path: "greet.js", old_string: "(n) => n", new_string: "(n) => `Hello, ${n}`", reason: "greeting" })] }],
    [{ content: "Step 1 done." }],
    // --- build step 2: tries an out-of-plan file first ---
    [{ tool_calls: [toolCall("e2", "edit_file", { path: "other.js", old_string: "keep = 1", new_string: "keep = 2" })] }],
    [{ tool_calls: [toolCall("e3", "write_file", { path: "greet.test.js", content: "// tests\n", reason: "tests" })] }],
    [{ content: "Step 2 done." }],
  ]);
  try {
    const page = await open(port, dir);

    // 1. Plan mode: the agent only gets read + plan tools, asks one question (with a default), writes the plan.
    await page.getByTestId("mode-select").selectOption("plan");
    await page.getByTestId("agent-input").fill("Refactor greeting across greet.js, other.js and index.js");
    await page.getByTestId("agent-input").press("Enter");
    await expect(page.getByTestId("question-prompt")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("answer-0")).toHaveValue("English");
    await page.getByTestId("submit-answers").click();

    await expect(page.getByTestId("plan-pane")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("plan-step")).toHaveCount(2);
    await expect(page.getByTestId("plan-goal")).toHaveText("The app can greet a user by name.");
    const planTools = requests[0]!.tools!.map((t) => t.function.name);
    for (const t of ["ask_user", "write_plan", "read_file", "grep", "repo_map"]) expect(planTools).toContain(t);
    for (const t of ["edit_file", "write_file", "delete_file", "run_checks"]) expect(planTools).not.toContain(t); // plan mode cannot edit code or run anything
    expect(readFileSync(`${dir}/greet.js`, "utf8")).toBe("export const greet = (n) => n;\n"); // plan mode wrote no code
    expect(existsSync(`${dir}/.forge/plans/add-greeting.md`)).toBe(true);
    await expect(page.getByTestId("plan-status")).toContainText("0/2 verified");

    // 2. The developer comments on a step; the comment is stored in the plan file.
    await page.getByRole("button", { name: "Comment" }).first().click();
    await page.getByLabel("Comment on step 1").fill("use template strings");
    await page.getByRole("button", { name: "Add" }).click();
    await expect.poll(() => readFileSync(`${dir}/.forge/plans/add-greeting.md`, "utf8")).toContain("> use template strings");

    // 3. Ambiguous wording never builds: nothing executes and no model request is made.
    const before = requests.length;
    await page.getByTestId("mode-select").selectOption("agent");
    await page.getByTestId("agent-input").fill("update the plan and go");
    await page.getByTestId("agent-input").press("Enter");
    await expect(page.getByTestId("notice").last()).toContainText("nothing was executed");
    expect(requests.length).toBe(before);
    expect(readFileSync(`${dir}/greet.js`, "utf8")).toBe("export const greet = (n) => n;\n");

    // 4. Build: steps run in order; an edit outside the plan stops and asks.
    await page.getByTestId("plan-build").click();
    await expect(page.getByTestId("addfile-prompt")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("addfile-question")).toHaveText("Step 2 also needs other.js. Add it to the plan?");
    await page.getByTestId("addfile-no").click();

    await expect(page.getByTestId("plan-status")).toContainText("done", { timeout: 60_000 });
    await expect(page.getByTestId("plan-status")).toContainText("2/2 verified");
    await expect(page.getByTestId("plan-step").first()).toHaveAttribute("data-status", "verified");
    await expect(page.getByTestId("plan-step").nth(1)).toHaveAttribute("data-status", "verified");

    // files: in-plan edits landed, the out-of-plan edit did not
    expect(readFileSync(`${dir}/greet.js`, "utf8")).toContain("Hello, ${n}");
    expect(existsSync(`${dir}/greet.test.js`)).toBe(true);
    expect(readFileSync(`${dir}/other.js`, "utf8")).toBe("export const keep = 1;\n");
    // the plan file records progress and keeps the comment
    const md = readFileSync(`${dir}/.forge/plans/add-greeting.md`, "utf8");
    expect(md).toMatch(/1\. \[x\]/);
    expect(md).toMatch(/2\. \[x\]/);
    expect(md).toContain("status: done");
    // the build prompt for each step was scoped and carried the reviewer comment
    const buildPrompts = requests.map((r) => r.messages.filter((m) => m.role === "user").at(-1)!.content).filter((c) => c.startsWith("Execute step"));
    expect(buildPrompts[0]).toContain("Execute step 1 of 2");
    expect(buildPrompts[0]).toContain("use template strings");
    // the edit tools were only exposed once the agent mode build started
    expect(requests[3]!.tools!.map((t) => t.function.name)).toContain("edit_file");
  } finally {
    server.close();
  }
});

test("a large request suggests Plan mode before anything is sent", async () => {
  const dir = project();
  const { server, port, requests } = await scripted([[{ tool_calls: [toolCall("q", "write_plan", { markdown: PLAN })] }], [{ content: "ok" }]]);
  try {
    const page = await open(port, dir);
    await page.getByTestId("mode-select").selectOption("agent");
    await page.getByTestId("agent-input").fill("Migrate the greeting module to a new API across the codebase");
    await page.getByTestId("agent-input").press("Enter");
    await expect(page.getByTestId("plan-suggestion")).toBeVisible();
    expect(requests).toHaveLength(0);
    await page.getByTestId("suggest-plan").click();
    await expect(page.getByTestId("mode-select")).toHaveValue("plan");
    await expect(page.getByTestId("plan-pane")).toBeVisible({ timeout: 20_000 });
    expect(requests[0]!.tools!.map((t) => t.function.name)).not.toContain("edit_file");
  } finally {
    server.close();
  }
});
