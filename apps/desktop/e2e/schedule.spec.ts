// The Schedule tab in the real window: jobs are added, changed, switched off and removed in .forge/schedule.json on disk, a bad job is
// refused before anything is written, and the chat-bridge setup shows placeholders for exactly the chosen bridges.
import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");
test.setTimeout(120_000);

const onDisk = (dir: string) => JSON.parse(readFileSync(`${dir}/.forge/schedule.json`, "utf8")) as { jobs: Record<string, unknown>[] };

test("jobs can be added, edited, disabled and removed, and an invalid job is refused before anything is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-sched-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  await page.keyboard.press("Control+Shift+K");
  await page.getByTestId("ctx-tab-schedule").click();
  await expect(page.getByTestId("sched-empty")).toBeVisible();

  // a bad cron expression: explained, and no file is created
  await page.getByTestId("sched-name").fill("nightly");
  await page.getByTestId("sched-cron").fill("61 * * * *");
  await page.getByTestId("sched-prompt").fill("review the commits");
  await page.getByTestId("sched-save").click();
  await expect(page.getByTestId("sched-error")).toContainText("minute");
  expect(existsSync(`${dir}/.forge/schedule.json`)).toBe(false);

  // fixed: saved to disk, listed with its next run
  await page.getByTestId("sched-cron").fill("0 2 * * *");
  await page.getByTestId("sched-save").click();
  const row = page.locator('[data-testid="sched-job"][data-job="nightly"]');
  await expect(row).toContainText("0 2 * * *");
  await expect(row.getByTestId("sched-next")).toContainText("Next run:");
  expect(onDisk(dir).jobs).toEqual([{ name: "nightly", cron: "0 2 * * *", prompt: "review the commits", command: "ask" }]);

  // a run job that applies changes is shown as such
  await page.getByTestId("sched-name").fill("deps");
  await page.getByTestId("sched-cron").fill("0 9 * * mon");
  await page.getByTestId("sched-command").selectOption("run");
  await page.getByTestId("sched-apply").check();
  await page.getByTestId("sched-prompt").fill("update patch versions");
  await page.getByTestId("sched-save").click();
  await expect(page.locator('[data-job="deps"]')).toContainText("run, applies changes");
  expect(onDisk(dir).jobs[1]).toMatchObject({ name: "deps", command: "run", apply: true });

  // a duplicate name is refused
  await page.getByTestId("sched-name").fill("deps");
  await page.getByTestId("sched-prompt").fill("again");
  await page.getByTestId("sched-save").click();
  await expect(page.getByTestId("sched-error")).toContainText("already a job");
  expect(onDisk(dir).jobs).toHaveLength(2);

  // edit keeps fields the screen does not show
  const raw = onDisk(dir);
  raw.jobs[0]!.maxCost = 1;
  writeFileSync(`${dir}/.forge/schedule.json`, JSON.stringify(raw));
  await page.getByTestId("ctx-tab-rules").click();
  await page.getByTestId("ctx-tab-schedule").click();
  await row.getByTestId("sched-edit").click();
  await page.getByTestId("sched-prompt").fill("review the commits carefully");
  await page.getByTestId("sched-save").click();
  await expect(row).toContainText("review the commits carefully");
  expect(onDisk(dir).jobs[0]).toMatchObject({ name: "nightly", prompt: "review the commits carefully", maxCost: 1 });

  // disable (kept in the file) and remove
  await row.getByTestId("sched-enabled").uncheck();
  await expect(row.getByTestId("sched-next")).toHaveText("Disabled");
  expect(onDisk(dir).jobs[0]!.enabled).toBe(false);
  await row.getByTestId("sched-remove").click();
  await expect(row).toHaveCount(0);
  expect(onDisk(dir).jobs.map((j) => j.name)).toEqual(["deps"]);
});

test("a broken schedule file is reported, not overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-sched-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  await page.evaluate(() => undefined);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(`${dir}/.forge`, { recursive: true });
  writeFileSync(`${dir}/.forge/schedule.json`, "{not json");
  await page.keyboard.press("Control+Shift+K");
  await page.getByTestId("ctx-tab-schedule").click();
  await expect(page.getByTestId("sched-file-error")).toContainText("not valid JSON");
  await page.getByTestId("sched-name").fill("x");
  await page.getByTestId("sched-prompt").fill("y");
  await page.getByTestId("sched-save").click();
  await expect(page.getByTestId("sched-error")).toContainText("not valid JSON");
  expect(readFileSync(`${dir}/.forge/schedule.json`, "utf8")).toBe("{not json"); // the developer's file is untouched
});

test("the chat-bridge setup lists only the chosen bridges, with placeholders and no secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-bridge-")).replaceAll("\\", "/");
  writeFileSync(`${dir}/a.ts`, "export const a = 1;\n");
  const page = await openWorkspace(dir);
  await page.keyboard.press("Control+Shift+K");
  await page.getByTestId("ctx-tab-schedule").click();
  const cmd = page.getByTestId("bridge-command");
  await expect(cmd).toContainText("FORGE_SERVE_TOKEN");
  await expect(cmd).not.toContainText("FORGE_SLACK_SIGNING_SECRET");
  await page.getByTestId("bridge-slack").check();
  await page.getByTestId("bridge-telegram").check();
  await expect(cmd).toContainText('$env:FORGE_SLACK_SIGNING_SECRET = "<paste FORGE_SLACK_SIGNING_SECRET>"');
  await expect(cmd).toContainText("FORGE_TELEGRAM_CHATS");
  await expect(cmd).not.toContainText("FORGE_LINEAR");
  await page.getByTestId("bridge-shell").selectOption("bash");
  await expect(cmd).toContainText('export FORGE_SLACK_SIGNING_SECRET="<paste FORGE_SLACK_SIGNING_SECRET>"');
  await expect(cmd).toContainText("forge-code serve --provider");
});
