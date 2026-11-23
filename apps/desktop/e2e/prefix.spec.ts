// What makes prompt caching pay off: within one run the system text (and tools) must be byte-identical from request to request,
// including after the agent has edited files, so each step reads the earlier ones from the cache instead of paying for them again.
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
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] });

test("the system text and tools do not change between the steps of a run, even after an edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-prefix-")).replaceAll("\\", "/");
  mkdirSync(`${dir}/src`);
  writeFileSync(`${dir}/src/math.ts`, "export function double(x: number): number {\n  return x * 2;\n}\n");
  writeFileSync(`${dir}/src/other.ts`, "export const other = 1;\n");
  writeFileSync(`${dir}/AGENTS.md`, "# Rules\n- Keep functions small\n");

  const script = [
    tool("c1", "read_file", { path: "src/math.ts" }),
    tool("c2", "edit_file", { path: "src/math.ts", old_string: "x * 2", new_string: "x * 3", reason: "triple it" }),
    tool("c3", "read_file", { path: "src/math.ts" }),
    { content: "done" },
  ];
  const requests: { system: string; tools: string; roles: string[] }[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const c of req) body += c;
    const b = JSON.parse(body) as { messages: { role: string; content: string }[]; tools?: unknown[] };
    requests.push({ system: b.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n#####\n"), tools: JSON.stringify(b.tools ?? []), roles: b.messages.map((m) => m.role) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: script[requests.length - 1] ?? { content: "done" } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(url);
    await page.getByTestId("review-mode").selectOption("auto");
    await page.getByTestId("settings-toggle").click();
    await expect(page.getByTestId("index-status")).toContainText(/Indexed [1-9]\d* files/, { timeout: 30_000 });
    await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
    const input = page.locator('[data-testid="agent-input"]:visible');
    await input.fill("make double triple");
    await input.press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("done", { timeout: 60_000 });

    expect(requests.length).toBe(4);
    expect(requests[0]!.system).toContain("Repo map"); // the volatile sections are in play, so this is the realistic case
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.tools, `tools of request ${i + 1}`).toBe(requests[0]!.tools);
      expect(requests[i]!.system, `system text of request ${i + 1}`).toBe(requests[0]!.system);
      // and each request is the previous one plus new messages at the end
      expect(requests[i]!.roles.slice(0, requests[i - 1]!.roles.length)).toEqual(requests[i - 1]!.roles);
    }
  } finally {
    srv.close();
  }
});
