// Phase 7 in the real window. Needs FORGE_CDP.
import { expect, test, type Page } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "./helpers";

test.skip(!process.env.FORGE_CDP, "needs a running Forge window (FORGE_CDP)");

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ index: 0, id, function: { name, arguments: JSON.stringify(args) } });

interface Req { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] }

const DOCS_HTML = `<html><body><h1>React Hooks</h1><p>Hooks let you use state.</p><h2>useState</h2><p>Call useState to add a state variable to your component.</p><h2>useEffect</h2><p>Use useEffect to synchronise with an external system.</p></body></html>`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-ctx-")).replace(/\\/g, "/");
  for (const d of ["src/components", "server", ".forge/rules"]) mkdirSync(`${dir}/${d}`, { recursive: true });
  writeFileSync(`${dir}/AGENTS.md`, "# Rules\n\nROOT-RULE: use pnpm\n");
  writeFileSync(`${dir}/.forge/rules/react.md`, '---\ndescription: React component conventions\nglobs: ["src/components/**/*.tsx"]\nactivation: auto\n---\nREACT-RULE: function components only\n');
  writeFileSync(`${dir}/.forge/rules/named.md`, "---\ndescription: exports\nactivation: always\n---\nNo default exports; use named exports only.\n");
  writeFileSync(`${dir}/src/components/Button.tsx`, "export default function Button() {\n  return null;\n}\n");
  writeFileSync(`${dir}/server/api.ts`, "export const api = 1;\n");
  writeFileSync(`${dir}/server/AGENTS.md`, "SERVER-RULE: validate all input\n");
  return dir;
}

/** Scripted OpenAI-compatible server. `handler` returns deltas for each request; it also serves a docs page. */
async function server(handler: (req: Req, n: number) => object[]) {
  const requests: Req[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    if (req.url === "/docs.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return void res.end(DOCS_HTML);
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as Req;
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const delta of handler(body, requests.length)) res.write(sse({ choices: [{ delta }] }));
    const chars = JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length;
    res.write(sse({ choices: [], usage: { prompt_tokens: Math.round((chars / 4) * 0.8), completion_tokens: 5 } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: (srv.address() as AddressInfo).port, requests };
}

async function configure(page: Page, port: number, extra: { budget?: number } = {}) {
  await page.getByTestId("settings-toggle").click();
  await page.getByTestId("base-url").fill(`http://127.0.0.1:${port}/v1`);
  await page.getByTestId("review-mode").selectOption("auto");
  if (extra.budget) await page.getByTestId("budget-tokens").fill(String(extra.budget));
  await page.getByTestId("settings-toggle").click();
}

async function openTreeFile(page: Page, ...path: string[]) {
  for (const seg of path) await page.getByTestId(`tree-${seg}`).click();
}
/** All the system text of a request (it is sent as several system messages: the stable part, then the changing sections). */
const sys = (r: Req) => r.messages.filter((m) => m.role === "system").map((m) => m.content).join(" | ");
const send = async (page: Page, text: string) => {
  await page.getByTestId("agent-input").fill(text);
  await page.getByTestId("agent-input").press("Enter");
};

test("rules panel explains why each rule applies; the glob rule reaches the model only for matching files", async () => {
  const dir = project();
  const { srv, port, requests } = await server(() => [{ content: "ok" }]);
  try {
    const page = await openWorkspace(dir);
    await configure(page, port);

    // A component file: react glob rule applies, with the reason shown.
    await openTreeFile(page, "src", "components", "Button.tsx");
    await page.keyboard.press("Control+Shift+K");
    await expect(page.getByTestId("context-pane")).toBeVisible();
    const react = page.getByTestId("rule").filter({ hasText: "react" }).first();
    await expect(react.getByTestId("rule-reason")).toContainText("glob match: src/components/**/*.tsx");
    await expect(page.getByTestId("rule").filter({ hasText: "ROOT-RULE" })).toContainText("always (repo root)");
    await page.keyboard.press("Control+Shift+K");

    await send(page, "describe the button component");
    await expect(page.getByTestId("assistant").last()).toContainText("ok", { timeout: 20_000 });
    expect(sys(requests[0]!)).toContain("REACT-RULE");
    expect(sys(requests[0]!)).toContain("ROOT-RULE");

    // Server code: the react rule is not applied; the nested server/AGENTS.md is.
    await openTreeFile(page, "server", "api.ts");
    await page.keyboard.press("Control+Shift+K");
    const list = page.getByTestId("rule-list");
    await expect(list).not.toContainText("REACT-RULE");
    await expect(page.getByTestId("rule").filter({ hasText: "server/AGENTS.md" }).first().getByTestId("rule-reason")).toContainText("nested AGENTS.md covers server/");
    await page.keyboard.press("Control+Shift+K");
    await send(page, "describe the api module");
    await expect.poll(() => requests.length).toBe(2);
    expect(sys(requests[1]!)).not.toContain("REACT-RULE");
    expect(sys(requests[1]!)).toContain("SERVER-RULE");
  } finally {
    srv.close();
  }
});

test("the rules linter flags a rule that contradicts the code; generated rules are proposed for review", async () => {
  const dir = project();
  const { srv, port } = await server(() => [{ content: "ok" }]);
  try {
    const page = await openWorkspace(dir);
    await configure(page, port);
    await page.keyboard.press("Control+Shift+K");
    await expect(page.getByTestId("rule-warnings")).toContainText("Bans default exports", { timeout: 20_000 });
    await expect(page.getByTestId("rule-warnings")).toContainText("1 file(s) use default exports");
    await page.getByTestId("generate-rules").click();
    await expect(page.getByTestId("rules-msg")).toContainText("Drafted AGENTS.md");
    await expect(page.getByTestId("pending-count")).toContainText("1 pending");
    expect(readFileSync(`${dir}/AGENTS.md`, "utf8")).toBe("# Rules\n\nROOT-RULE: use pnpm\n"); // nothing written without review
  } finally {
    srv.close();
  }
});

test("a correction is offered as a memory (never saved silently), reaches later prompts, and can be deleted", async () => {
  const dir = project();
  const { srv, port, requests } = await server(() => [{ content: "noted" }]);
  try {
    const page = await openWorkspace(dir);
    await configure(page, port);
    await send(page, "always use async/await here");
    await expect(page.getByTestId("correction-banner")).toBeVisible();
    await expect(page.getByTestId("assistant").last()).toContainText("noted", { timeout: 20_000 });
    expect(existsSync(`${dir}/.forge/memory`)).toBe(false); // offered, not saved
    await page.getByTestId("save-memory").click();
    const saved = () => (existsSync(`${dir}/.forge/memory`) ? readdirSync(`${dir}/.forge/memory`).filter((f) => f.endsWith(".md")) : []);
    await expect.poll(() => saved().length).toBe(1); // ignore the atomic-write temp file
    expect(readFileSync(`${dir}/.forge/memory/${saved()[0]}`, "utf8")).toContain("always use async/await here");

    await send(page, "describe the server api module");
    await expect.poll(() => requests.length).toBe(2);
    expect(sys(requests[1]!)).toContain("always use async/await here");

    await page.keyboard.press("Control+Shift+K");
    await page.getByTestId("ctx-tab-memory").click();
    await expect(page.getByTestId("memory")).toHaveCount(1);
    await page.getByTestId("memory-delete").click();
    await expect(page.getByTestId("memory")).toHaveCount(0);
    await expect.poll(() => readdirSync(`${dir}/.forge/memory`).length).toBe(0);
  } finally {
    srv.close();
  }
});

test("docs are indexed on request and retrieved via @docs; sub-agents return only a report", async () => {
  const dir = project();
  const { srv, port, requests } = await server((req) => {
    const first = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? ""; // the latest user message
    const isChild = first.includes("When you are done, write a concise report");
    const hasToolResult = req.messages.some((m) => m.role === "tool");
    if (isChild) return [{ content: "Callers of api: none found." }];
    if (first.startsWith("find every caller of api")) return hasToolResult ? [{ content: "Parent done." }] : [{ tool_calls: [toolCall("d1", "delegate", { task: "find every caller of api" })] }];
    return [{ content: "docs answer" }];
  });
  try {
    const page = await openWorkspace(dir);
    await configure(page, port);

    // Docs tab: fetch is explicit and indexes passages.
    await page.keyboard.press("Control+Shift+K");
    await page.getByTestId("ctx-tab-docs").click();
    await page.getByLabel("Docs name").fill("react");
    await page.getByLabel("Docs URL").fill(`http://127.0.0.1:${port}/docs.html`);
    await page.getByTestId("docs-add").click();
    await expect(page.getByTestId("docs-msg")).toContainText("Indexed 3 passages", { timeout: 20_000 });
    await expect(page.getByTestId("doc")).toHaveCount(1);
    await page.keyboard.press("Control+Shift+K");

    // @docs:react attachment: the relevant passage reaches the model, labelled untrusted.
    await page.getByTestId("attach-kind").selectOption("docs");
    await page.getByTestId("attach-arg").fill("react");
    await page.getByTestId("attach-add").click();
    await expect(page.getByTestId("chip")).toContainText("docs: react");
    await send(page, "how do I add a state variable with useState");
    await expect(page.getByTestId("assistant").last()).toContainText("docs answer", { timeout: 20_000 });
    const docsReq = requests.find((r) => sys(r).includes("Docs: react"))!;
    expect(sys(docsReq)).toContain("untrusted reference data");
    expect(sys(docsReq)).toContain("Call useState to add a state variable");

    // Sub-agent: parent delegates; only the report returns to the main thread.
    await page.getByTestId("mode-select").selectOption("agent");
    await send(page, "find every caller of api across the services");
    await page.getByTestId("suggest-continue").click(); // it looks like a large request: carry on in agent mode
    await expect(page.getByTestId("assistant").last()).toContainText("Parent done.", { timeout: 30_000 });
    await expect(page.getByTestId("tool-call").filter({ hasText: "delegate" })).toHaveCount(1);
    const childReq = requests.find((r) => r.messages.find((m) => m.role === "user")?.content.includes("When you are done, write a concise report"))!;
    expect(childReq.messages.filter((m) => m.role === "user")).toHaveLength(1); // fresh context: only its own task
    expect(childReq.tools!.map((t) => t.function.name)).not.toContain("delegate");
    expect(childReq.tools!.map((t) => t.function.name)).not.toContain("edit_file");
    const parentFinal = requests.at(-1)!;
    expect(parentFinal.messages.filter((m) => m.role === "tool").at(-1)!.content).toBe("Sub-agent report:\nCallers of api: none found.");
  } finally {
    srv.close();
  }
});

test("a long session compacts without losing rules; the token meter calibrates to the provider", async () => {
  const dir = project();
  const { srv, port, requests } = await server((req) => {
    if (sys(req).startsWith("You are compressing")) return [{ content: "SUMMARY-MARK: we have been analysing the module. Open decisions: none." }];
    return [{ content: `Analysis ${"detail about the module ".repeat(60)}` }];
  });
  try {
    const page = await openWorkspace(dir);
    await configure(page, port, { budget: 4500 });
    await page.getByTestId("agent-input").fill("");
    for (let i = 0; i < 9; i++) {
      await send(page, `continue analysing the module part ${i} of the button component`);
      await expect(page.getByTestId("assistant").last()).toContainText("Analysis", { timeout: 20_000 });
      await expect.poll(async () => await page.getByTestId("agent-input").inputValue()).toBe("");
    }
    await expect(page.getByTestId("compaction-notice").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("compaction-notice").first()).toContainText("Rules, plan and file list were kept");
    const summarizer = requests.filter((r) => sys(r).startsWith("You are compressing"));
    expect(summarizer.length).toBeGreaterThan(0);
    // every normal request, before and after the compaction, still carried the rules
    for (const r of requests.filter((x) => !sys(x).startsWith("You are compressing"))) expect(sys(r)).toContain("ROOT-RULE");
    // after compaction the conversation holds the summary block
    const lastNormal = requests.filter((x) => !sys(x).startsWith("You are compressing")).at(-1)!;
    expect(lastNormal.messages.some((m) => m.content.startsWith("[Summary of the earlier conversation"))).toBe(true);
    // meter is calibrated against the provider's reported usage and shows a category breakdown
    await expect(page.getByTestId("token-meter")).not.toContainText("(est.)");
    const tip = (await page.getByTestId("token-meter").getAttribute("title"))!;
    expect(tip).toContain("Rules:");
    expect(tip).toContain("Conversation:");
    expect(tip).toContain("calibrated");
  } finally {
    srv.close();
  }
});
