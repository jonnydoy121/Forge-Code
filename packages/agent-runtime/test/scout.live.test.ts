// Opt-in measurement of a small LOCAL model as the scout: does it cope with tool calls on small edits, how well does it size up
// requests compared with the free wording heuristic, and are its commit messages usable?
// Skipped unless FORGE_LIVE_SCOUT=<ollama model> is set (e.g. qwen2.5-coder:1.5b); it talks to Ollama on this machine only.
// Set FORGE_LIVE_OUT=<file> to also write the results as JSON.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@forge/protocol";
import { Gateway } from "@forge/model-gateway";
import { READ_TOOLS, createEditTools, createToolHost } from "@forge/tool-host";
import { nodeFs } from "@forge/tool-host/src/node-fs";
import { Runtime, TRIAGE_PROMPT, classifyPrompt, parseComplexity, type Complexity } from "../src";

const MODEL = process.env.FORGE_LIVE_SCOUT ?? "";
const RUNS = Number(process.env.FORGE_LIVE_RUNS ?? 3);
const results: Record<string, unknown> = { model: MODEL, runs: RUNS };

const gateway = new Gateway({ fetch: (u, i) => fetch(u, i), maxRetries: 0 });
gateway.register("local", { kind: "ollama" });

interface Task {
  name: string;
  mode: "agent" | "ask";
  prompt: string;
  files: Record<string, string>;
  /** true when the outcome is right, given the files afterwards and the model's answer */
  check: (read: (p: string) => string, answer: string) => boolean;
}

const MATH = "export function double(x: number): number {\n  return x * 2;\n}\n";
const TASKS: Task[] = [
  { name: "rename a function", mode: "agent", prompt: "In utils.ts rename the function add to sum.", files: { "utils.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n" }, check: (r) => /function sum\b/.test(r("utils.ts")) && !/function add\b/.test(r("utils.ts")) },
  { name: "fix a typo", mode: "agent", prompt: "Fix the typo 'recieve' in README.md.", files: { "README.md": "# Demo\n\nPlease recieve the package.\n" }, check: (r) => r("README.md").includes("receive") && !r("README.md").includes("recieve") },
  { name: "add a comment", mode: "agent", prompt: "Add the comment line // helper directly above the function double in math.ts.", files: { "math.ts": MATH }, check: (r) => /\/\/ helper\s*\n\s*export function double/.test(r("math.ts")) },
  { name: "change a colour", mode: "agent", prompt: "Change the primary colour in style.css from red to blue.", files: { "style.css": ":root {\n  --primary: red;\n  --gap: 4px;\n}\n" }, check: (r) => r("style.css").includes("--primary: blue") && r("style.css").includes("--gap: 4px") },
  { name: "answer a question about code", mode: "ask", prompt: "What does the function double in math.ts return?", files: { "math.ts": MATH }, check: (_r, a) => /x\s*\*\s*2|twice|two times|2\s*times|multipl\w*\s+(it\s+|x\s+|the \w+\s+)?by\s+2/i.test(a) /* a fact only the file holds: "double" is already in the question */ },
  { name: "add a function (a standard task)", mode: "agent", prompt: "Add a function triple to math.ts that returns its argument times 3.", files: { "math.ts": MATH }, check: (r) => /function triple/.test(r("math.ts")) && /\*\s*3/.test(r("math.ts")) },
];

async function runTask(t: Task) {
  const root = mkdtempSync(join(tmpdir(), "forge-scout-")).replaceAll("\\", "/");
  for (const [p, c] of Object.entries(t.files)) writeFileSync(`${root}/${p}`, c);
  const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");
  const sink = {
    read: async (p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    propose: async (p: string, next: string | null) => {
      if (next !== null) writeFileSync(p, next);
      return { status: "applied" as const, added: 1, removed: 1 };
    },
  };
  const tools = createToolHost({ root, fs: nodeFs, tools: [...READ_TOOLS, ...createEditTools(sink)] });
  const rt = new Runtime({ gateway, tools, provider: "local", model: MODEL, limits: { maxSteps: 8, maxCostUsd: 1, maxSeconds: 180 } });
  const events: AgentEvent[] = [];
  const t0 = Date.now();
  let answer = "";
  let error = "";
  try {
    for await (const e of rt.run({ mode: t.mode, prompt: t.prompt })) {
      events.push(e);
      if (e.type === "text") answer += e.delta;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const results_ = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
  const prompts = events.filter((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done").map((e) => e.usage.inputTokens);
  return {
    ok: !error && t.check(read, answer),
    ms: Date.now() - t0,
    toolCalls: results_.length,
    failedCalls: results_.filter((r) => !r.result.ok).length,
    modelCalls: prompts.length,
    maxPromptTokens: Math.max(0, ...prompts),
    error,
    said: answer.replace(/\s+/g, " ").slice(0, 200),
  };
}

// What a person would call each request. "trivial" = a short question or a small well-defined edit; "complex" = architecture, design
// or hard multi-file debugging; everything else "standard".
const LABELLED: [string, "ask" | "agent", Complexity][] = [
  ["What does the retry helper do?", "ask", "trivial"],
  ["where is the config loaded", "ask", "trivial"],
  ["Explain what src/auth.ts exports", "ask", "trivial"],
  ["rename the variable x to count in utils.ts", "agent", "trivial"],
  ["fix the typo in the README heading", "agent", "trivial"],
  ["change the button colour to blue", "agent", "trivial"],
  ["Add a --verbose flag to the CLI and print each step", "agent", "standard"],
  ["Add retry with backoff to the fetch call in src/api.ts", "agent", "standard"],
  ["Write unit tests for the date parser in src/date.ts", "agent", "standard"],
  ["The login form does not show an error when the password is wrong; fix it", "agent", "standard"],
  ["Add pagination to the users list endpoint", "agent", "standard"],
  ["Make the sidebar collapsible", "agent", "standard"],
  ["Redesign the architecture of the sync engine: src/sync/a.ts, src/sync/b.ts and src/sync/c.ts share a race condition. Find the root cause and migrate them to a single queue with a clear ownership model.", "agent", "complex"],
  ["Design the database schema and migration plan for multi-tenant support across the whole codebase: users, billing and audit logs all need tenant isolation, and the current queries in src/db/*.ts assume a single tenant.", "agent", "complex"],
  ["There is a deadlock that only appears under load; the lock order in src/queue/worker.ts, src/queue/lease.ts and src/store/tx.ts looks inconsistent. Work out the root cause and propose a redesign.", "agent", "complex"],
  ["What is the architecture of this repo?", "ask", "standard"],
  ["Refactor the error handling across every module to use one Result type", "agent", "standard"],
  ["Summarise the changes in the last commit", "ask", "trivial"],
];

const DIFFS = [
  "diff --git a/utils.ts b/utils.ts\n--- a/utils.ts\n+++ b/utils.ts\n@@ -1,3 +1,3 @@\n-export function add(a: number, b: number): number {\n+export function sum(a: number, b: number): number {\n   return a + b;\n }",
  "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # Demo\n \n-Please recieve the package.\n+Please receive the package.",
  "diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -10,6 +10,14 @@\n+async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {\n+  for (let i = 0; ; i++) {\n+    try {\n+      return await fn();\n+    } catch (e) {\n+      if (i >= tries - 1) throw e;\n+    }\n+  }\n+}\n export async function load(id: string) {\n-  return fetch(`/api/${id}`).then((r) => r.json());\n+  return withRetry(() => fetch(`/api/${id}`).then((r) => r.json()));\n }",
];

async function ask(prompt: string, system?: string): Promise<{ text: string; ms: number }> {
  const t0 = Date.now();
  let text = "";
  const messages = [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user" as const, content: prompt }];
  for await (const ev of gateway.stream({ provider: "local", model: MODEL, messages })) if (ev.type === "text") text += ev.delta;
  return { text, ms: Date.now() - t0 };
}

describe.skipIf(!MODEL)(`live: ${MODEL || "a local model"} as the scout (Ollama on this machine)`, () => {
  it("small edits through the real agent loop and tools", { timeout: 20 * 60_000 }, async () => {
    const rows: Record<string, unknown>[] = [];
    for (const t of TASKS) {
      const runs: Awaited<ReturnType<typeof runTask>>[] = [];
      for (let i = 0; i < RUNS; i++) runs.push(await runTask(t));
      const n = (f: (r: Awaited<ReturnType<typeof runTask>>) => number) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
      rows.push({ task: t.name, success: `${runs.filter((r) => r.ok).length}/${RUNS}`, meanSeconds: +(n((r) => r.ms) / 1000).toFixed(1), meanToolCalls: +n((r) => r.toolCalls).toFixed(1), failedToolCalls: runs.reduce((a, r) => a + r.failedCalls, 0), maxPromptTokens: Math.max(...runs.map((r) => r.maxPromptTokens)), errors: runs.map((r) => r.error).filter(Boolean).slice(0, 1), firstAnswer: runs[0]!.said });
    }
    results.tasks = rows;
    console.table(rows);
    expect(rows).toHaveLength(TASKS.length);
  });

  it("sizing up requests: the model against the free wording heuristic", { timeout: 10 * 60_000 }, async () => {
    let heuristic = 0;
    let model = 0;
    let unparsable = 0;
    const misses: Record<string, unknown>[] = [];
    let ms = 0;
    for (const [prompt, mode, label] of LABELLED) {
      const h = classifyPrompt(prompt, mode).complexity;
      const r = await ask(prompt, TRIAGE_PROMPT);
      ms += r.ms;
      const m = parseComplexity(r.text);
      if (m === null) unparsable++;
      if (h === label) heuristic++;
      if (m === label) model++;
      if (h !== label || m !== label) misses.push({ prompt: prompt.slice(0, 60), label, heuristic: h, model: m ?? `(${r.text.slice(0, 20).trim()})` });
    }
    const summary = { prompts: LABELLED.length, heuristicRight: heuristic, modelRight: model, modelUnparsable: unparsable, meanSecondsPerCall: +(ms / LABELLED.length / 1000).toFixed(2) };
    results.triage = { ...summary, misses };
    console.log(summary);
    console.table(misses);
    expect(summary.prompts).toBeGreaterThan(0);
  });

  it("commit messages", { timeout: 5 * 60_000 }, async () => {
    const out = [];
    for (const diff of DIFFS) {
      const r = await ask(`Write a concise git commit message (imperative mood, max 72 char subject, optional short body) for this change. Reply with the message only.\n\n${diff}`);
      const subject = r.text.trim().split("\n")[0] ?? "";
      out.push({ subject, subjectLength: subject.length, seconds: +(r.ms / 1000).toFixed(1), within72: subject.length > 0 && subject.length <= 72 });
    }
    results.commitMessages = out;
    console.table(out);
    expect(out).toHaveLength(DIFFS.length);
    if (process.env.FORGE_LIVE_OUT) writeFileSync(process.env.FORGE_LIVE_OUT, JSON.stringify(results, null, 2));
  });
});
