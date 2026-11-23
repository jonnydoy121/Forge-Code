// Specialist agents in the real window: a coordinator delegates to a named specialist that has its own instructions, its own (narrower)
// tools and its own model tier, and only a report comes back. A mock model records what each request carries.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const call = (id: string, name: string, args: Record<string, unknown>) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] });

interface Seen {
  model: string;
  tools: string[];
  system: string;
  lastTool?: string;
}

test("the coordinator delegates to named specialists: their own instructions, tools and model tier; only a report comes back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-spec-")).replaceAll("\\", "/");
  mkdirSync(`${dir}/.forge/agents`, { recursive: true });
  writeFileSync(`${dir}/.forge/agents/reviewer.md`, "---\ndescription: Reviews code for security problems\ntools: [read_file]\n---\nREVIEWER-INSTRUCTIONS: look for injection and report file and line.\n");
  writeFileSync(`${dir}/.forge/agents/planner.md`, "---\ndescription: Designs approaches\ntier: architect\n---\nPLANNER-INSTRUCTIONS: weigh two designs.\n");
  writeFileSync(`${dir}/app.ts`, "export const x = 1;\n");

  const script = [
    { delta: call("c1", "delegate", { task: "audit app.ts", agent: "reviewer" }) }, // 1: coordinator
    { delta: { content: "REVIEW-REPORT: no injection found" } }, //                   2: the reviewer
    { delta: call("c2", "delegate", { task: "design the cache", agent: "planner" }) }, // 3: coordinator
    { delta: { content: "PLAN-REPORT: use a map" } }, //                              4: the planner
    { delta: { content: "all reported" } }, //                                       5: coordinator
  ];
  const seen: Seen[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const c of req) body += c;
    const b = JSON.parse(body) as { model: string; tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    seen.push({ model: b.model, tools: (b.tools ?? []).map((t) => t.function.name), system: b.messages.filter((m) => m.role === "system").map((m) => m.content).join(" | "), lastTool: [...b.messages].reverse().find((m) => m.role === "tool")?.content });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: script[seen.length - 1]?.delta ?? { content: "done" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(url);
    await page.getByTestId("main-model").fill("builder-model");
    await page.getByTestId("architect-provider").selectOption("openai"); // a model server on this machine, as the architect
    await page.getByTestId("architect-model").fill("architect-model");
    await page.getByTestId("architect-base-url").fill(url);
    await page.getByTestId("settings-toggle").click();

    // The specialists are listed (read-only) under Context > Agents.
    await page.keyboard.press("Control+Shift+K");
    await page.getByTestId("ctx-tab-agents").click();
    await expect(page.getByTestId("agent-def")).toHaveCount(2);
    const reviewer = page.locator('[data-agent="reviewer"]');
    await expect(reviewer).toContainText("Reviews code for security problems");
    await expect(reviewer.getByTestId("agent-tools")).toContainText("read_file");
    await expect(page.locator('[data-agent="planner"]').getByTestId("agent-tier")).toHaveText("architect");
    await page.keyboard.press("Control+Shift+K");

    await page.locator('[data-testid="mode-select"]:visible').selectOption("ask");
    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.fill("have the specialists look at app.ts");
    await input.press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("all reported", { timeout: 90_000 });

    expect(seen).toHaveLength(5);
    // The coordinator is told who exists, and can only name them.
    expect(seen[0]!.tools).toContain("delegate");
    // The reviewer: its own instructions, ONLY the tool it was allowed (and no delegate, so no recursion), the default model.
    expect(seen[1]!.system).toContain('You are the "reviewer" specialist');
    expect(seen[1]!.system).toContain("REVIEWER-INSTRUCTIONS");
    expect(seen[1]!.tools).toEqual(["read_file"]);
    expect(seen[1]!.model).toBe("builder-model");
    // Only its report reached the coordinator, labelled with who wrote it.
    expect(seen[2]!.lastTool).toContain('Specialist "reviewer" report');
    expect(seen[2]!.lastTool).toContain("REVIEW-REPORT: no injection found");
    expect(seen[2]!.system).not.toContain("REVIEWER-INSTRUCTIONS"); // the coordinator's own context stays clean
    // The planner: its own instructions, all the read-only tools (none were restricted), and the architect's model.
    expect(seen[3]!.system).toContain("PLANNER-INSTRUCTIONS");
    expect(seen[3]!.tools).toContain("read_file");
    expect(seen[3]!.tools).toContain("grep");
    expect(seen[3]!.tools).not.toContain("delegate");
    expect(seen[3]!.model).toBe("architect-model");
    expect(seen[4]!.lastTool).toContain('Specialist "planner" report');
    expect(seen[4]!.model).toBe("builder-model");
  } finally {
    srv.close();
  }
});
