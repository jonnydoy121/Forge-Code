// How long from pressing Enter until the model request leaves the app? That is the overhead Forge-Code adds to every message
// (starting the agent process, assembling context, listing tools, crossing process boundaries).
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test("time from pressing Enter to the model request leaving the app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-latency-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  // A realistic project: some rules, skills and prompts, so context assembly has real work to do.
  writeFileSync(`${dir}/AGENTS.md`, "# Rules\n- Use TypeScript\n- Keep functions small\n");
  mkdirSync(`${dir}/.forge/skills/greet`, { recursive: true });
  writeFileSync(`${dir}/.forge/skills/greet/SKILL.md`, "---\ndescription: Greet\n---\nSay hello.");
  mkdirSync(`${dir}/.forge/prompts`, { recursive: true });
  writeFileSync(`${dir}/.forge/prompts/review.md`, "Review $ARGUMENTS");
  for (let i = 0; i < 200; i++) writeFileSync(`${dir}/m${i}.ts`, `export function f${i}() { return ${i}; }\n`);

  const arrivals: number[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    arrivals.push(Date.now());
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "ok" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();
    const input = page.locator('[data-testid="agent-input"]:visible');
    const answer = page.locator('[data-testid="assistant"]:visible');

    const samples: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = arrivals.length;
      await page.evaluate(() => ((window as unknown as { __trace: [string, number][] }).__trace = []));
      await input.fill(`question number ${i}`);
      const t0 = Date.now();
      await input.press("Enter");
      await expect.poll(() => arrivals.length, { timeout: 30_000 }).toBeGreaterThan(before);
      samples.push(arrivals[before]! - t0);
      if (i === 0 || i === 1) {
        const tr = await page.evaluate(() => (window as unknown as { __trace: [string, number][] }).__trace);
        const base = tr[0]![1];
        console.log(`TRACE message ${i + 1}: ` + tr.map(([l, t]) => `${l} +${Math.round(t - base)}`).join(" | "));
      }
      await expect(answer).toHaveCount(i + 1, { timeout: 30_000 });
    }
    // Launch the agent process a second time (the page reload stops the first): the executable has now been run before.
    await page.reload();
    await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
    await page.evaluate((d) => (window as unknown as { __forge: { openFolder: (x: string) => Promise<void> } }).__forge.openFolder(d), dir);
    await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();
    const again = arrivals.length;
    await input.fill("after a reload");
    const t1 = Date.now();
    await input.press("Enter");
    await expect.poll(() => arrivals.length, { timeout: 30_000 }).toBeGreaterThan(again);
    samples.push(arrivals[again]! - t1);
    console.log(`LATENCY ms from Enter to model request: first message ${samples[0]}, then ${samples.slice(1, 4).join(", ")}; first message after a reload (process launched a second time) ${samples[4]}`);
    // Budget for the steady state: once the agent process is running, a message leaves the app within a fraction of a second.
    expect(Math.max(...samples.slice(1, 4)), "warm messages").toBeLessThan(200);
    expect(samples[4], "first message after a reload (process launched a second time)").toBeLessThan(600);
  } finally {
    srv.close();
  }
});
