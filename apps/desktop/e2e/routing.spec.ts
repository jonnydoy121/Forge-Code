// Model routing in the real window: which model each request names. One mock server plays every tier and records the `model`
// of each request, so the test sees exactly what would have been sent to a scout, a builder and an architect.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(240_000);

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const tool = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ index: 0, id: `c-${name}-${Math.random().toString(36).slice(2, 7)}`, function: { name, arguments: JSON.stringify(args) } }] });

test("the architect takes over after two failed checks, plan mode uses it, a model change applies at once, and triage sends simple questions to the scout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-route-")).replaceAll("\\", "/");
  mkdirSync(`${dir}/src`);
  writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler" }, include: ["src"] }));
  writeFileSync(`${dir}/package.json`, JSON.stringify({ name: "demo" }));

  // What the model says to each request, in order. The first three change a file nobody opens, so the language-server check
  // is what fails the first two rounds.
  const script = [
    tool("write_file", { path: "src/broken.ts", content: 'export const n: number = "one";\n', reason: "new module" }), // 1: builder, fails the check
    tool("edit_file", { path: "src/broken.ts", old_string: '"one"', new_string: '"two"', reason: "try again" }), // 2: builder, fails again
    tool("edit_file", { path: "src/broken.ts", old_string: '"two"', new_string: "3", reason: "fix the type" }), // 3: architect
    { content: "fixed" }, // 4: architect, still
    { content: "the plan" }, // 5: plan mode
    { content: "builder two answering" }, // 6: after the model change
    { content: "scout answering" }, // 7: a short question, with triage on
  ];
  const models: string[] = [];
  const sent: string[][] = []; // the roles of the messages in each request: how much of the conversation the model was given
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const c of req) body += c;
    models.push(JSON.parse(body).model as string);
    sent.push((JSON.parse(body).messages as { role: string }[]).map((m) => m.role));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: script[models.length - 1] ?? { content: "done" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  try {
    const page = await openWorkspace(dir);
    const input = page.locator('[data-testid="agent-input"]:visible');
    const mode = page.locator('[data-testid="mode-select"]:visible');
    const send = async (m: "agent" | "plan" | "ask", prompt: string) => {
      // The previous run may still be finishing (its last verification); a message sent meanwhile is ignored.
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 120_000 });
      await mode.selectOption(m);
      await input.fill(prompt);
      await input.press("Enter");
    };
    const settings = async (fn: () => Promise<void>) => {
      await page.getByTestId("settings-toggle").click();
      await fn();
      await page.getByTestId("settings-toggle").click();
    };

    await settings(async () => {
      await page.getByTestId("base-url").fill(url);
      await page.getByTestId("main-model").fill("builder-model");
      await page.getByTestId("review-mode").selectOption("auto"); // edits reach disk, so verification runs
      for (const [tier, model] of [["scout", "scout-model"], ["architect", "architect-model"]] as const) {
        await page.getByTestId(`${tier}-provider`).selectOption("openai"); // an OpenAI-compatible server on this machine
        await page.getByTestId(`${tier}-model`).fill(model);
        await page.getByTestId(`${tier}-base-url`).fill(url);
      }
    });

    // 1. Two failed checks hand the fix to the architect, and the panel says so.
    await send("agent", "add a module");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("fixed", { timeout: 120_000 });
    expect(models).toEqual(["builder-model", "builder-model", "architect-model", "architect-model"]);
    await expect(page.getByTestId("notice").filter({ hasText: "Model: architect (architect-model)" })).toBeVisible();
    await expect(page.getByTestId("notice").filter({ hasText: "checks failed 2 times" })).toBeVisible();
    expect(readFileSync(`${dir}/src/broken.ts`, "utf8")).toContain("= 3;"); // the architect's fix landed

    // 2. Plan mode is the architect's.
    await send("plan", "plan a refactor");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("the plan", { timeout: 60_000 });
    expect(models.at(-1)).toBe("architect-model");

    // 3. A model change applies to the very next message, and the conversation comes with it. (A settings change used to start a
    //    fresh session that had forgotten everything the panel still showed.)
    await settings(async () => {
      await page.getByTestId("main-model").fill("builder-two");
    });
    await send("agent", "Add a --verbose flag to the CLI and print each step");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("builder two answering", { timeout: 60_000 });
    expect(models.at(-1)).toBe("builder-two");
    expect(sent.at(-1)!.length).toBeGreaterThan(5); // the earlier turns, not just system + this prompt
    expect(sent.at(-1)).toContain("tool");

    // 4. With triage on, a short question goes to the scout.
    await settings(async () => {
      await page.getByTestId("triage").selectOption("heuristic");
    });
    await send("ask", "What does the retry helper do?");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("scout answering", { timeout: 60_000 });
    expect(models.at(-1)).toBe("scout-model");
    expect(sent.at(-1)!.length).toBeGreaterThan(sent[5]!.length); // still the same conversation after another settings change
    expect(models).toHaveLength(7);
  } finally {
    srv.close();
  }
});
