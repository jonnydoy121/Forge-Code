// Isolated threads: each gets its own git worktree and branch; the developer merges or discards it.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

function gitProject() {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-iso-")).replace(/[\\]/g, "/");
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "core.autocrlf", "false");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "initial");
  return dir;
}

async function modelServer() {
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const answered = body.includes('"role":"tool"');
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = { index: 0, id: "e", function: { name: "edit_file", arguments: JSON.stringify({ path: "a.js", old_string: "a = 1", new_string: "a = 100", reason: "bump a" }) } };
    res.write(sse({ choices: [{ delta: answered ? { content: "done in the thread" } : { tool_calls: [call] } }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: (srv.address() as AddressInfo).port };
}

test("an isolated thread edits its own worktree, then merges into main", async () => {
  const dir = gitProject();
  const { srv, port } = await modelServer();
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();

    await page.getByTestId("thread-new-isolated").click();
    await expect(page.getByTestId("thread-tab-t2")).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
    await expect(page.getByTestId("thread-message")).toContainText("forge/t2");
    const wt = `${dir}/.forge/worktrees/t2`;
    expect(existsSync(`${wt}/a.js`)).toBe(true);

    // The thread edits: the change lands in its worktree, never in the main checkout.
    await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
    await page.locator('[data-testid="agent-input"]:visible').fill("bump a");
    await page.locator('[data-testid="agent-input"]:visible').press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("done in the thread", { timeout: 30_000 });
    expect(readFileSync(`${wt}/a.js`, "utf8")).toBe("export const a = 100;\n");
    expect(readFileSync(`${dir}/a.js`, "utf8")).toBe("export const a = 1;\n");

    // Its runtime state lives outside the worktree, so it can never be committed to the thread's branch.
    expect(existsSync(`${wt}/.forge/checkpoints`)).toBe(false);
    expect(existsSync(`${wt}/.forge/audit`)).toBe(false);
    expect(existsSync(`${wt}/.forge/pending`)).toBe(false);
    expect(existsSync(`${dir}/.forge/threads/t2`)).toBe(true);
    expect(sh(dir, "status", "--porcelain")).not.toContain("worktrees"); // the nested checkout is invisible to the main one

    await page.getByTestId("thread-changes").click();
    await expect(page.getByTestId("thread-message")).toContainText("a.js");

    // Merge: main gets the change, the checkout and branch are gone, the history shows the merge.
    await page.getByTestId("thread-merge").click();
    await expect(page.getByTestId("thread-tab-t2")).toHaveCount(0, { timeout: 20_000 });
    expect(readFileSync(`${dir}/a.js`, "utf8")).toBe("export const a = 100;\n");
    expect(existsSync(wt)).toBe(false);
    expect(sh(dir, "branch", "--list", "forge/t2").trim()).toBe("");
    expect(sh(dir, "log", "--oneline", "-n", "3")).toContain("Merge Forge-Code thread");
    expect(sh(dir, "ls-files")).not.toContain(".forge"); // none of the thread's internals were committed
  } finally {
    srv.close();
  }
});

test("discarding an isolated thread throws its work away", async () => {
  const dir = gitProject();
  const { srv, port } = await modelServer();
  try {
    const page = await openWorkspace(dir);
    await page.getByTestId("settings-toggle").click();
    await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
    await page.getByTestId("settings-toggle").click();

    await page.getByTestId("thread-new-isolated").click();
    await expect(page.getByTestId("thread-tab-t2")).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
    await page.locator('[data-testid="agent-input"]:visible').fill("bump a");
    await page.locator('[data-testid="agent-input"]:visible').press("Enter");
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("done in the thread", { timeout: 30_000 });

    await page.getByTestId("thread-discard").click();
    await expect(page.getByTestId("thread-discard")).toContainText("Click again"); // a deliberate second click
    await page.getByTestId("thread-discard").click();
    await expect(page.getByTestId("thread-tab-t2")).toHaveCount(0, { timeout: 20_000 });
    expect(existsSync(`${dir}/.forge/worktrees/t2`)).toBe(false);
    expect(sh(dir, "branch", "--list", "forge/t2").trim()).toBe("");
    expect(readFileSync(`${dir}/a.js`, "utf8")).toBe("export const a = 1;\n");
  } finally {
    srv.close();
  }
});

test("an isolated thread explains itself when the folder is not a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-nogit-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  await page.getByTestId("thread-new-isolated").click();
  await expect(page.getByTestId("thread-message")).toContainText("git repository", { timeout: 20_000 });
  await expect(page.getByTestId("thread-tab-t2")).toHaveCount(0);
});
