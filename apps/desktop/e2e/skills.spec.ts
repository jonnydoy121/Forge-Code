// Skills in the real app: the index reaches the model, loading a skill is silent, running its script asks first and
// goes through the real exec (sandboxed when sandboxing is on), and declining stops it.
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

function skillWorkspace(opts: { typed?: boolean; broken?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-skill-")).replace(/[\\]/g, "/");
  const sk = `${dir}/.forge/skills/greet`;
  mkdirSync(sk, { recursive: true });
  writeFileSync(`${sk}/SKILL.md`, "---\ndescription: Write a greeting file\n---\n# Greet\nRun greet.js with a name.\n");
  writeFileSync(`${sk}/greet.js`, "const fs = require('fs');\nconst args = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\nfs.writeFileSync('greeting.txt', 'Hello, ' + args.name + '!');\nconsole.log('wrote greeting for ' + args.name);\n");
  if (opts.typed) {
    const decl = { "greet.js": { description: "Write greeting.txt for a person", parameters: { type: "object", properties: { name: { type: "string", maxLength: 40 } }, required: ["name"], additionalProperties: false } } };
    writeFileSync(`${sk}/tools.json`, JSON.stringify(decl));
  }
  if (opts.broken) {
    mkdirSync(`${dir}/.forge/skills/broken`, { recursive: true });
    writeFileSync(`${dir}/.forge/skills/broken/SKILL.md`, "# Broken\nA skill whose tools.json is invalid.");
    writeFileSync(`${dir}/.forge/skills/broken/tools.json`, "{not json");
  }
  writeFileSync(`${dir}/a.js`, "export const a = 1;\n");
  return dir;
}

async function modelServer(scriptArgs: unknown = { name: "World" }) {
  const bodies: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(body);
    const toolMessages = (body.match(/"role":"tool"/g) ?? []).length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tool = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `c${toolMessages}`, function: { name, arguments: JSON.stringify(args) } }] });
    const delta = toolMessages === 0 ? tool("use_skill", { name: "greet" }) : toolMessages === 1 ? tool("run_skill_script", { skill: "greet", script: "greet.js", args: scriptArgs }) : { content: "all done" };
    res.write(sse({ choices: [{ delta }] }));
    res.write(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, bodies, port: (srv.address() as AddressInfo).port };
}

/** Point the app at the mock model, optionally turn the OS sandbox off, and ask the agent to greet. */
async function start(page: import("@playwright/test").Page, port: number, opts: { sandbox: boolean }) {
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
  if (!opts.sandbox) await page.getByTestId("sandbox-on").uncheck();
  await page.getByTestId("settings-toggle").click();
  await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
  await page.locator('[data-testid="agent-input"]:visible').fill("greet the world");
  await page.locator('[data-testid="agent-input"]:visible').press("Enter");
}

const toolOutput = async (page: import("@playwright/test").Page) => {
  for (const el of await page.locator('[data-testid="tool-call"]:visible').all()) await el.click().catch(() => {});
  return page.locator('[data-testid="messages"]:visible').innerText();
};

test("an approved skill script runs in the workspace with the model's arguments", async () => {
  const dir = skillWorkspace();
  const { srv, bodies, port } = await modelServer();
  try {
    const page = await openWorkspace(dir);
    await start(page, port, { sandbox: false }); // Node lives under Program Files, which an unelevated sandbox cannot grant

    // Loading the skill is a read: the first (and only) prompt is for the script.
    await expect(page.getByTestId("permission-prompt")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="permission-prompt"] pre')).toContainText("run_skill_script");
    await page.getByTestId("allow-once").click();

    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("all done", { timeout: 30_000 });
    expect(readFileSync(`${dir}/greeting.txt`, "utf8")).toBe("Hello, World!");
    expect(existsSync(`${dir}/.forge/skill-runs`) ? readdirSync(`${dir}/.forge/skill-runs`) : []).toEqual([]); // temp args file removed

    // The first request carried the skills index and the skill tools.
    expect(bodies[0]).toContain("greet: Write a greeting file");
    expect(bodies[0]).toContain("use_skill");
    expect(bodies[0]).toContain("run_skill_script");
  } finally {
    srv.close();
  }
});

test("with the sandbox on, the script is routed through it and the result says so", async () => {
  const dir = skillWorkspace();
  const { srv, port } = await modelServer();
  try {
    const page = await openWorkspace(dir);
    await start(page, port, { sandbox: true });
    await expect(page.getByTestId("permission-prompt")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("allow-once").click();
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("all done", { timeout: 30_000 });
    // Whether Node can run inside the sandbox depends on the machine (granting access under Program Files needs elevation),
    // but the model is always told which isolation was used, and why a tool may be missing.
    expect(await toolOutput(page)).toContain("ran in the OS sandbox");
  } finally {
    srv.close();
  }
});

test("declining the prompt means the script never runs", async () => {
  const dir = skillWorkspace();
  const { srv, port } = await modelServer();
  try {
    const page = await openWorkspace(dir);
    await start(page, port, { sandbox: false });
    await expect(page.getByTestId("permission-prompt")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("deny").click();
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("all done", { timeout: 30_000 });
    expect(existsSync(`${dir}/greeting.txt`)).toBe(false);
  } finally {
    srv.close();
  }
});

test("the Skills panel lists skills, marks typed scripts, and surfaces a broken tools.json", async () => {
  const dir = skillWorkspace({ typed: true, broken: true });
  const page = await openWorkspace(dir);
  await page.keyboard.press("Control+Shift+K");
  await page.getByTestId("ctx-tab-skills").click();
  const greet = page.locator('[data-testid="skill"][data-skill="greet"]');
  await expect(greet).toContainText("Write a greeting file");
  await expect(greet.getByTestId("skill-source")).toHaveText("this repo");
  await expect(greet.getByTestId("skill-scripts")).toContainText("greet.js (typed)");
  const broken = page.locator('[data-testid="skill"][data-skill="broken"]');
  await expect(broken.getByTestId("skill-problems")).toContainText("tools.json is not valid");
  await expect(greet.getByTestId("skill-problems")).toHaveCount(0);
});

test("a typed script rejects wrong arguments from the model, and nothing runs", async () => {
  const dir = skillWorkspace({ typed: true });
  const { srv, port } = await modelServer({}); // the model forgets the required "name"
  try {
    const page = await openWorkspace(dir);
    await start(page, port, { sandbox: false });
    await expect(page.getByTestId("permission-prompt")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("allow-once").click();
    await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("all done", { timeout: 30_000 });
    expect(await toolOutput(page)).toContain('missing required argument "name"');
    expect(existsSync(`${dir}/greeting.txt`)).toBe(false);
  } finally {
    srv.close();
  }
});

// Automatic skills: a request that clearly matches a skill gets its instructions up front; the setting turns that off.
for (const on of [true, false]) {
  test(`a matching request ${on ? "gets" : "does not get"} the skill's instructions up front (setting ${on ? "on" : "off"})`, async () => {
    const dir = skillWorkspace();
    const { srv, bodies, port } = await modelServer();
    try {
      const page = await openWorkspace(dir);
      await page.getByTestId("settings-toggle").click();
      await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
      await page.getByTestId("sandbox-on").uncheck();
      if (!on) await page.getByTestId("auto-skills").uncheck();
      else await expect(page.getByTestId("auto-skills")).toBeChecked(); // on by default
      await page.getByTestId("settings-toggle").click();
      await page.locator('[data-testid="mode-select"]:visible').selectOption("agent");
      await page.locator('[data-testid="agent-input"]:visible').fill("write a greeting file for the world");
      await page.locator('[data-testid="agent-input"]:visible').press("Enter");
      await expect(page.getByTestId("permission-prompt")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("deny").click();
      await expect(page.locator('[data-testid="assistant"]:visible').last()).toContainText("all done", { timeout: 30_000 });
      if (on) {
        expect(bodies[0]).toContain('House rules from \\"greet\\"');
        expect(bodies[0]).toContain("Run greet.js with a name."); // the skill's own instructions, not just its index line
      } else {
        expect(bodies[0]).not.toContain("House rules from");
        expect(bodies[0]).toContain("greet: Write a greeting file"); // the index is still there to load from
      }
    } finally {
      srv.close();
    }
  });
}
