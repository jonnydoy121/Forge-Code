// Phase 4 in the real window: agent proposes a multi-file edit, the developer reviews it, a conflict is
// surfaced instead of overwriting, and checkpoints roll everything back. Needs FORGE_CDP and FORGE_WS.
import { expect, test } from "@playwright/test";
import { openWorkspace } from "./helpers";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cdp = process.env.FORGE_CDP;
const ws = process.env.FORGE_WS ?? "";
test.skip(!cdp, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const read = (f: string) => readFileSync(join(ws, f), "utf8");
const edit = (path: string, from: string, to: string) => ({
  index: 0,
  id: `call-${path}`,
  function: { name: "edit_file", arguments: JSON.stringify({ path, old_string: from, new_string: to, replace_all: true, reason: `rename in ${path}` }) },
});

test("multi-file rename: review, conflict, accept/reject, rollback", async () => {
  const original = { c: read("c.ts"), use: read("use.ts") };
  let n = 0;
  const server = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _; // drain
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (++n === 1) {
      // two parallel tool calls (indexes 0 and 1)
      res.write(sse({ choices: [{ delta: { tool_calls: [edit("c.ts", "greet", "hello"), { ...edit("use.ts", "greet", "hello"), index: 1 }] } }] }));
    } else {
      res.write(sse({ choices: [{ delta: { content: "Renamed greet to hello in 2 files." } }] }));
    }
    res.write(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const page = await openWorkspace(ws);
  try {
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await expect(page.getByTestId("review-mode")).toHaveValue("review");
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("mode-select").selectOption("agent");
    await expect(page.getByTestId("index-status")).toContainText(/Indexed/, { timeout: 60_000 });

    // The agent proposes edits to two files. Nothing is written to disk yet.
    await page.getByTestId("agent-input").fill("Rename greet to hello everywhere");
    await page.getByTestId("agent-input").press("Enter");
    // "Rename ... everywhere" looks like a large change, so Forge suggests planning first; carry on in agent mode.
    await page.getByTestId("suggest-continue").click();
    await expect(page.getByTestId("pending-banner")).toContainText("2 files", { timeout: 20_000 });
    expect(read("c.ts")).toBe(original.c);
    expect(read("use.ts")).toBe(original.use);

    // Inline decorations appear on the open file.
    await page.getByTestId("tree-c.ts").click();
    await expect(page.locator(".pending-changed").first()).toBeVisible();

    // Multi-file review pane with per-file counts and a change set.
    await page.getByTestId("pending-banner").click();
    await expect(page.getByTestId("review-pane")).toBeVisible();
    await expect(page.getByTestId("review-file")).toHaveCount(2);
    await expect(page.getByTestId("change-set")).toHaveCount(1);

    // The developer edits use.ts on disk while the agent's change is pending -> conflict, never an overwrite.
    const devVersion = "import { greet } from './c';\ngreet('dev edit');\n";
    writeFileSync(join(ws, "use.ts"), devVersion);
    await page.getByTestId("review-file").filter({ hasText: "use.ts" }).click();
    await page.getByTestId("accept-file").click();
    await expect(page.getByTestId("conflict")).toBeVisible();
    expect(read("use.ts")).toBe(devVersion);
    await page.getByLabel("Merged result").fill("import { hello } from './c';\nhello('dev edit');\n");
    await page.getByTestId("save-resolution").click();
    await expect.poll(() => read("use.ts")).toBe("import { hello } from './c';\nhello('dev edit');\n");

    // Accept the remaining file; disk now has the rename.
    await expect(page.getByTestId("review-file")).toHaveCount(1);
    await page.getByTestId("accept-file").click();
    await expect(page.getByTestId("review-empty")).toBeVisible();
    expect(read("c.ts")).toBe(original.c.replaceAll("greet", "hello"));

    // Explain / checkpoints / rollback of the whole session restores files exactly.
    await page.getByTestId("timeline-toggle").click();
    await expect(page.getByTestId("checkpoint")).toHaveCount(2);
    await expect(page.getByTestId("timeline")).toContainText("file edits only");
    await page.getByTestId("rollback-session").click();
    await expect(page.getByTestId("timeline-msg")).toContainText("Rolled back the whole session");
    expect(read("c.ts")).toBe(original.c);
    expect(read("use.ts")).toBe(devVersion); // back to the developer's own version, not the pre-agent one
  } finally {
    server.close();
    writeFileSync(join(ws, "c.ts"), original.c);
    writeFileSync(join(ws, "use.ts"), original.use);
  }
});
