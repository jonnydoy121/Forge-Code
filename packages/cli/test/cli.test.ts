import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedGateway } from "@forge/model-gateway";
import type { StreamEvent } from "@forge/protocol";
import { parseArgs, runCli, type Io } from "../src/cli";
import { unifiedDiff } from "../src/format";

const done: StreamEvent = { type: "done", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.1 } };
const text = (t: string): StreamEvent => ({ type: "text", delta: t });
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });

function project() {
  const dir = mkdtempSync(join(tmpdir(), "forge-cli-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  return dir;
}
function io(cwd: string, gateway: ScriptedGateway | undefined, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { out: (t) => out.push(t), err: (t) => err.push(t), env, cwd, gateway };
  return { i, out: () => out.join(""), err: () => err.join("") };
}
const edit = () => [call("1", "edit_file", { path: "a.js", old_string: "b = 2", new_string: "b = 20", reason: "bump b" }), done];

describe("arguments", () => {
  it("parses commands and options, and takes the key only from the environment", () => {
    const o = parseArgs(["run", "fix", "the", "bug", "--model", "m", "--apply", "--max-steps", "5"], { FORGE_PROVIDER: "openai" });
    expect(o).toMatchObject({ command: "run", prompt: "fix the bug", model: "m", apply: true, maxSteps: 5, provider: "openai" });
    expect(parseArgs(["ask", "x", "--api-key", "sk-secret"], {})).toEqual({ error: "unknown option --api-key" });
  });
  it("rejects bad input with a clear message", () => {
    expect(parseArgs([], {})).toEqual({ error: "missing command (ask or run)" });
    expect(parseArgs(["fly", "x"], {})).toEqual({ error: 'unknown command "fly" (expected ask or run)' });
    expect(parseArgs(["run"], {})).toEqual({ error: '"run" needs a prompt' });
    expect(parseArgs(["ask", "x", "--apply"], {})).toEqual({ error: "--apply only makes sense with run" });
    expect(parseArgs(["run", "x", "--max-cost", "-1"], {})).toEqual({ error: "--max-cost must be a positive number of dollars" });
    expect(parseArgs(["run", "x", "--provider", "bogus"], {})).toEqual({ error: "--provider must be one of ollama, openai, anthropic, gemini, openrouter, groq, lmstudio, strata" });
    expect(parseArgs(["--help"], {})).toEqual({ help: true });
  });
});

describe("forge-code run", () => {
  it("prints the proposed diff and writes nothing by default", async () => {
    const dir = project();
    const t = io(dir, new ScriptedGateway([edit(), [text("Bumped b."), done]]));
    expect(await runCli(["run", "bump b"], t.i)).toBe(0);
    expect(t.out()).toContain("-export const b = 2;");
    expect(t.out()).toContain("+export const b = 20;");
    expect(t.out()).toContain("nothing written");
    expect(readFileSync(`${dir}/a.js`, "utf8")).toContain("b = 2;");
  });

  it("writes the change only with --apply", async () => {
    const dir = project();
    const t = io(dir, new ScriptedGateway([edit(), [text("done"), done]]));
    expect(await runCli(["run", "bump b", "--apply"], t.i)).toBe(0);
    expect(t.out()).toContain("Applied 1 file(s).");
    expect(readFileSync(`${dir}/a.js`, "utf8")).toBe("export const a = 1;\nexport const b = 20;\nexport const c = 3;\n");
  });

  it("emits a machine-readable result with --json", async () => {
    const dir = project();
    const t = io(dir, new ScriptedGateway([edit(), [text("ok"), done]]));
    await runCli(["run", "bump b", "--json"], t.i);
    const r = JSON.parse(t.out());
    expect(r).toMatchObject({ answer: "ok", applied: false, stopped: null });
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: "a.js", added: 1, removed: 1 });
    expect(r.files[0].abs).toBeUndefined();
  });

  it("exits 2 when it stops at a limit", async () => {
    const dir = project();
    const loop = Array.from({ length: 5 }, (_, n) => [call(`r${n}`, "read_file", { path: "a.js" }), done]);
    const t = io(dir, new ScriptedGateway(loop));
    expect(await runCli(["run", "read forever", "--max-steps", "2"], t.i)).toBe(2);
    expect(t.err()).toContain("stopped at the steps limit");
  });
});

describe("forge-code ask", () => {
  it("is read-only: the model is not even offered edit tools", async () => {
    const dir = project();
    const gw = new ScriptedGateway([[text("It exports three constants."), done]]);
    const t = io(dir, gw);
    expect(await runCli(["ask", "what does a.js export?"], t.i)).toBe(0);
    expect(t.out()).toContain("three constants");
    expect(gw.requests[0]!.tools!.map((x) => x.name)).not.toContain("edit_file");
  });

  it("reports a missing model clearly", async () => {
    const t = io(project(), undefined);
    expect(await runCli(["ask", "x"], t.i)).toBe(1);
    expect(t.err()).toContain("no model given");
  });
});

describe("unified diff", () => {
  it("includes context and correct line numbers across several hunks", () => {
    const base = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
    const d = unifiedDiff("f.txt", base, [
      { id: "a", oldStart: 1, oldLines: ["2"], newLines: ["two", "2b"] },
      { id: "b", oldStart: 8, oldLines: ["9"], newLines: ["nine"] },
    ]);
    expect(d).toContain("--- a/f.txt\n+++ b/f.txt");
    expect(d).toContain("@@ -1,4 +1,5 @@");
    expect(d).toContain("@@ -7,4 +8,4 @@"); // old line 7 is new line 8 after the first hunk added one line
  });
  it("marks new files", () => {
    expect(unifiedDiff("n.txt", null, [{ id: "a", oldStart: 0, oldLines: [""], newLines: ["hello", ""] }])).toContain("--- /dev/null");
  });
});

describe("saved prompts", () => {
  it("expands /name arguments from .forge/prompts before running", async () => {
    const dir = project();
    mkdirSync(`${dir}/.forge/prompts`, { recursive: true });
    writeFileSync(`${dir}/.forge/prompts/review.md`, "---\ndescription: Review\n---\nReview $ARGUMENTS for bugs.\n");
    const gw = new ScriptedGateway([[text("fine"), done]]);
    const t = io(dir, gw);
    expect(await runCli(["ask", "/review a.js"], t.i)).toBe(0);
    const sent = JSON.stringify(gw.requests[0]!.messages);
    expect(sent).toContain("Review a.js for bugs.");
    expect(sent).not.toContain("/review");
    expect(t.err()).toContain("using saved prompt /review");
  });

  it("treats an unknown slash command as ordinary text", async () => {
    const gw = new ScriptedGateway([[text("ok"), done]]);
    await runCli(["ask", "/nosuch thing"], io(project(), gw).i);
    expect(JSON.stringify(gw.requests[0]!.messages)).toContain("/nosuch thing");
  });
});

describe("rules in the CLI", () => {
  const systemText = (gw: ScriptedGateway) => gw.requests[0]!.messages.filter((m) => m.role === "system").map((m) => m.content).join(" | ");

  it("puts the repo's rules (AGENTS.md, .forgerules and the other rule files) in the model's context, so a headless run follows them", async () => {
    const dir = project();
    writeFileSync(`${dir}/AGENTS.md`, "# Repo\nALWAYS-USE-PNPM\n");
    writeFileSync(`${dir}/.forgerules`, "FORGERULES-NAME-TESTS-AFTER-BEHAVIOUR\n");
    writeFileSync(`${dir}/.cursorrules`, "CURSOR-STYLE-RULE\n");
    const gw = new ScriptedGateway([[text("ok"), done]]);
    expect(await runCli(["ask", "what are the rules?"], io(dir, gw).i)).toBe(0);
    const sys = systemText(gw);
    for (const rule of ["ALWAYS-USE-PNPM", "FORGERULES-NAME-TESTS-AFTER-BEHAVIOUR", "CURSOR-STYLE-RULE"]) expect(sys).toContain(rule);
    expect(sys).toContain("Project rules");
  });

  it("adds nothing when the repo has no rules (and does not fail on the missing rules folders), and the rules also reach a run that edits", async () => {
    const plain = new ScriptedGateway([[text("ok"), done]]);
    expect(await runCli(["ask", "hi"], io(project(), plain).i)).toBe(0);
    expect(systemText(plain)).not.toContain("Project rules");

    const dir = project();
    writeFileSync(`${dir}/.forgerules`, "RULE-FOR-EDITS\n");
    const gw = new ScriptedGateway([edit(), [text("done"), done]]);
    expect(await runCli(["run", "bump b"], io(dir, gw).i)).toBe(0);
    expect(systemText(gw)).toContain("RULE-FOR-EDITS");
  });

  it("reads scoped rules from .forge/rules too (the always-on ones)", async () => {
    const dir = project();
    mkdirSync(`${dir}/.forge/rules`, { recursive: true });
    writeFileSync(`${dir}/.forge/rules/style.md`, "---\ndescription: Style\nactivation: always\n---\nSCOPED-ALWAYS-RULE\n");
    const gw = new ScriptedGateway([[text("ok"), done]]);
    await runCli(["ask", "hi"], io(dir, gw).i);
    expect(systemText(gw)).toContain("SCOPED-ALWAYS-RULE");
  });
});

describe("skills in the CLI", () => {
  function withSkill() {
    const dir = project();
    mkdirSync(`${dir}/.forge/skills/release`, { recursive: true });
    writeFileSync(`${dir}/.forge/skills/release/SKILL.md`, "---\ndescription: Cut a release\n---\n# Release\nRun the checks, then tag.\n");
    writeFileSync(`${dir}/.forge/skills/release/bump.js`, "console.log('would bump')");
    return dir;
  }

  it("puts the skills index in the model's context and lets it load a skill, but never offers scripts", async () => {
    const dir = withSkill();
    const gw = new ScriptedGateway([[call("1", "use_skill", { name: "release" }), done], [text("tagged"), done]]);
    const t = io(dir, gw);
    expect(await runCli(["ask", "cut a release"], t.i)).toBe(0);
    const first = JSON.stringify(gw.requests[0]);
    expect(first).toContain("release: Cut a release");
    const offered = gw.requests[0]!.tools!.map((x) => x.name);
    expect(offered).toContain("use_skill");
    expect(offered).not.toContain("run_skill_script"); // the CLI has no sandbox: instructions only
    const toolText = JSON.stringify(gw.requests[1]!.messages.filter((m) => m.role === "tool"));
    expect(toolText).toContain("Run the checks, then tag.");
    expect(toolText).not.toContain("run_skill_script"); // not even advertised in the skill's own listing
  });

  it("offers nothing skill-related when the repo has no skills", async () => {
    const gw = new ScriptedGateway([[text("ok"), done]]);
    await runCli(["ask", "x"], io(project(), gw).i);
    expect(gw.requests[0]!.tools!.map((x) => x.name)).not.toContain("use_skill");
  });
});

describe("user skills in the CLI", () => {
  it("includes skills from HOME/.forge/skills, and a repo skill overrides a personal one of the same name", async () => {
    const dir = project();
    const home = mkdtempSync(join(tmpdir(), "forge-cli-home-")).replace(/[\\]/g, "/");
    mkdirSync(`${home}/.forge/skills/standup`, { recursive: true });
    writeFileSync(`${home}/.forge/skills/standup/SKILL.md`, "---\ndescription: Write my standup\n---\nSummarise yesterday.");
    mkdirSync(`${home}/.forge/skills/release`, { recursive: true });
    writeFileSync(`${home}/.forge/skills/release/SKILL.md`, "---\ndescription: PERSONAL release\n---\nmine");
    mkdirSync(`${dir}/.forge/skills/release`, { recursive: true });
    writeFileSync(`${dir}/.forge/skills/release/SKILL.md`, "---\ndescription: REPO release\n---\nrepo's");
    const gw = new ScriptedGateway([[text("ok"), done]]);
    await runCli(["ask", "hi"], io(dir, gw, { HOME: home }).i);
    const sent = JSON.stringify(gw.requests[0]);
    expect(sent).toContain("standup: Write my standup");
    expect(sent).toContain("release: REPO release");
    expect(sent).not.toContain("PERSONAL release");
  });
});

describe("provider presets", () => {
  it("a preset means an OpenAI-compatible provider at its own address", () => {
    const o = parseArgs(["ask", "hi", "--provider", "gemini"], {}) as { provider: string; baseUrl: string; preset: string };
    expect(o).toMatchObject({ provider: "openai", preset: "gemini" });
    expect(o.baseUrl).toContain("generativelanguage.googleapis.com");
    expect((parseArgs(["ask", "hi", "--provider", "lmstudio"], {}) as { baseUrl: string }).baseUrl).toBe("http://localhost:1234/v1");
  });

  it("an explicit base URL wins, and an unknown provider is refused naming the presets", () => {
    expect((parseArgs(["ask", "hi", "--provider", "groq", "--base-url", "http://x/v1"], {}) as { baseUrl: string }).baseUrl).toBe("http://x/v1");
    expect(parseArgs(["ask", "hi", "--provider", "nope"], {})).toMatchObject({ error: expect.stringContaining("gemini") });
    expect(parseArgs(["ask", "hi"], { FORGE_PROVIDER: "openrouter" })).toMatchObject({ preset: "openrouter" });
  });
});

describe("specialists in the CLI", () => {
  const withAgent = (md: string) => {
    const dir = project();
    mkdirSync(`${dir}/.forge/agents`, { recursive: true });
    writeFileSync(`${dir}/.forge/agents/reviewer.md`, md);
    return dir;
  };

  it("offers delegate with the specialist, and the specialist runs with its own instructions and only its tools", async () => {
    const dir = withAgent("---\ndescription: Reviews code\ntools: [read_file]\n---\nYou are the strict reviewer.");
    const gw = new ScriptedGateway([
      [call("1", "delegate", { task: "review a.js", agent: "reviewer" }), done],
      [text("Looks fine."), done], // the specialist's report
      [text("The reviewer says it looks fine."), done],
    ]);
    const t = io(dir, gw);
    expect(await runCli(["ask", "have it reviewed", "--model", "m", "--json"], t.i)).toBe(0);
    expect(JSON.parse(t.out()).answer).toBe("The reviewer says it looks fine.");
    expect(gw.requests[0]!.tools!.map((x) => x.name)).toContain("delegate");
    const sub = gw.requests[1]!;
    expect(JSON.stringify(sub.messages)).toContain("strict reviewer");
    expect(sub.tools!.map((x) => x.name)).toEqual(["read_file"]); // not grep, not edit_file, not delegate
  });

  it("refuses a specialist that does not exist, and tells the coordinator", async () => {
    const dir = withAgent("---\ndescription: Reviews code\n---\nReview.");
    const gw = new ScriptedGateway([[call("1", "delegate", { task: "x", agent: "ghost" }), done], [text("ok"), done]]);
    const t = io(dir, gw);
    expect(await runCli(["ask", "go", "--model", "m", "--json"], t.i)).toBe(0);
    expect(JSON.stringify(gw.requests[1]!.messages)).toContain("ghost");
  });
});

describe("automatic skills in the CLI", () => {
  const withSkill = () => {
    const dir = project();
    mkdirSync(`${dir}/.forge/skills/git-commit-style`, { recursive: true });
    writeFileSync(`${dir}/.forge/skills/git-commit-style/SKILL.md`, "---\ndescription: Write commit messages and pull request descriptions in the team convention\n---\nEnd every message with Refs: FRG-<n>.\n");
    return dir;
  };
  const systemText = (gw: ScriptedGateway) => JSON.stringify(gw.requests[0]!.messages);

  it("puts a matching skill's instructions in front of the model, and says so", async () => {
    const gw = new ScriptedGateway([[text("ok"), done]]);
    const t = io(withSkill(), gw);
    expect(await runCli(["ask", "Write the commit message and pull request description for this change", "--model", "m"], t.i)).toBe(0);
    expect(systemText(gw)).toContain("End every message with Refs: FRG-<n>.");
    expect(t.err()).toContain("applying skill: git-commit-style");
  });

  it("applies nothing for an unrelated request, and nothing with --no-auto-skills (the index stays)", async () => {
    const unrelated = new ScriptedGateway([[text("ok"), done]]);
    await runCli(["ask", "explain what a closure is", "--model", "m"], io(withSkill(), unrelated).i);
    expect(systemText(unrelated)).not.toContain("Refs: FRG-");

    const off = new ScriptedGateway([[text("ok"), done]]);
    const t = io(withSkill(), off);
    await runCli(["ask", "Write the commit message and pull request description for this change", "--no-auto-skills", "--model", "m"], t.i);
    expect(systemText(off)).not.toContain("Refs: FRG-");
    expect(systemText(off)).toContain("git-commit-style"); // still listed so the model can load it
    expect(t.err()).not.toContain("applying skill");
  });
});

describe("Strata preset", () => {
  it("points at the local Strata server and takes its key only from STRATA_API_KEY", () => {
    expect(parseArgs(["ask", "hi", "--provider", "strata"], {})).toMatchObject({ provider: "openai", preset: "strata", baseUrl: "http://127.0.0.1:47831/v1" });
  });

  it("sends the Strata key to Strata, and never an OpenAI key", async () => {
    const seen: (string | undefined)[] = [];
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetched.push(String(url));
      seen.push((init?.headers as Record<string, string> | undefined)?.authorization);
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const dir = project();
      const withStrata = io(dir, undefined, { STRATA_API_KEY: "strata-key", OPENAI_API_KEY: "sk-openai-secret" });
      expect(await runCli(["ask", "hi", "--provider", "strata", "--model", "swift-iq2_xs"], withStrata.i)).toBe(0);
      expect(fetched[0]).toBe("http://127.0.0.1:47831/v1/chat/completions");
      expect(seen[0]).toBe("Bearer strata-key");
      seen.length = 0;
      const withoutKey = io(dir, undefined, { OPENAI_API_KEY: "sk-openai-secret" });
      await runCli(["ask", "hi", "--provider", "strata", "--model", "swift-iq2_xs"], withoutKey.i);
      expect(seen.every((h) => !h || !h.includes("sk-openai-secret"))).toBe(true); // the OpenAI key was not sent to Strata
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
