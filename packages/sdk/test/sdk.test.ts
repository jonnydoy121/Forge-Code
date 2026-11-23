import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { parseHooksConfig } from "@forge/verify";
import { validateArgs, type ParamSchema as StoreSchema } from "@forge/context-store";
import { defineTool, hookInput, runHook, runTool, toolsManifest, type ProcessIo } from "../src/index";

const capture = (argv: string[] = []) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: ProcessIo = { argv: ["node", "script", ...argv], cwd: "/work", out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join(""), err: () => err.join("") };
};
const argsFile = (args: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "forge-sdk-")), "args.json");
  writeFileSync(f, JSON.stringify(args));
  return f;
};

describe("custom tools", () => {
  const bump = defineTool({
    description: "Bump the version",
    parameters: { type: "object", properties: { level: { type: "string", enum: ["patch", "minor", "major"] } }, required: ["level"] },
    run: (args, ctx) => `bumped ${String(args.level)} in ${ctx.cwd}`,
  });

  it("reads the argument file, runs, and prints the result", async () => {
    const c = capture([argsFile({ level: "minor" })]);
    expect(await runTool(bump, c.io)).toBe(0);
    expect(c.out()).toBe("bumped minor in /work");
  });

  it("prints an object result as JSON, and reports a thrown error with exit 1", async () => {
    const asJson = capture([argsFile({})]);
    expect(await runTool(defineTool({ description: "x", run: () => ({ ok: true }) }), asJson.io)).toBe(0);
    expect(JSON.parse(asJson.out())).toEqual({ ok: true });
    const bad = capture([argsFile({})]);
    expect(await runTool(defineTool({ description: "x", run: () => Promise.reject(new Error("no such package")) }), bad.io)).toBe(1);
    expect(bad.err()).toContain("no such package");
  });

  it("reports an unreadable argument file, and runs with no arguments when none is given", async () => {
    const missing = capture(["/nonexistent/args.json"]);
    expect(await runTool(bump, missing.io)).toBe(1);
    expect(missing.err()).toContain("could not read the arguments file");
    const none = capture();
    expect(await runTool(defineTool({ description: "x", run: (a) => `got ${Object.keys(a).length}` }), none.io)).toBe(0);
    expect(none.out()).toBe("got 0");
  });

  it("writes a tools.json that Forge-Code's own validator accepts and enforces", () => {
    const manifest = JSON.parse(toolsManifest({ "bump.js": bump })) as Record<string, { description: string; parameters: StoreSchema }>;
    expect(manifest["bump.js"]!.description).toBe("Bump the version");
    expect(validateArgs(manifest["bump.js"]!.parameters, { level: "patch" })).toEqual([]);
    expect(validateArgs(manifest["bump.js"]!.parameters, { level: "huge" }).length).toBeGreaterThan(0);
    expect(validateArgs(manifest["bump.js"]!.parameters, {}).length).toBeGreaterThan(0);
  });
});

describe("lifecycle hooks", () => {
  it("reads the FORGE_* context Forge-Code passes", () => {
    const i = hookInput({ FORGE_EVENT: "PreToolUse", FORGE_TOOL: "run_command", FORGE_FILE: "a.ts", FORGE_FILES: "a.ts\nb.ts", FORGE_TOOL_ARGS: '{"command":"rm -rf x"}' });
    expect(i).toEqual({ event: "PreToolUse", tool: "run_command", file: "a.ts", files: ["a.ts", "b.ts"], toolArgs: { command: "rm -rf x" } });
    expect(hookInput({ FORGE_TOOL_ARGS: '{"cut off' }).toolArgs).toBe('{"cut off');
    expect(hookInput({})).toMatchObject({ event: "", files: [] });
  });

  it("exits 0 for nothing or text, 2 to block (with the reason), and 1 when the hook itself crashes", async () => {
    const quiet = capture();
    expect(await runHook(() => undefined, {}, quiet.io)).toBe(0);
    const note = capture();
    expect(await runHook(() => "formatted", {}, note.io)).toBe(0);
    expect(note.out()).toBe("formatted");
    const blocked = capture();
    expect(await runHook((i) => (i.tool === "run_command" ? { block: "no shell here" } : undefined), { FORGE_TOOL: "run_command" }, blocked.io)).toBe(2);
    expect(blocked.out()).toBe("no shell here");
    const crash = capture();
    expect(await runHook(() => Promise.reject(new Error("boom")), {}, crash.io)).toBe(1);
    expect(crash.err()).toContain("boom");
  });
});

describe("as real processes", () => {
  let dir = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "forge-sdk-proc-"));
    const sdk = fileURLToPath(new URL("../src/index.ts", import.meta.url)).replace(/\\/g, "/");
    const entry = (name: string, body: string) => writeFileSync(join(dir, `${name}.ts`), `import { defineTool, runTool, runHook } from ${JSON.stringify(sdk)};\n${body}\n`);
    entry("tool", `runTool(defineTool({ description: "echo", run: (a) => "hello " + String(a.who) })).then((c) => process.exit(c));`);
    entry("hook", `runHook((i) => (i.file.endsWith(".secret") ? { block: "do not touch " + i.file } : undefined)).then((c) => process.exit(c));`);
    for (const n of ["tool", "hook"]) await build({ entryPoints: [join(dir, `${n}.ts`)], bundle: true, platform: "node", format: "cjs", outfile: join(dir, `${n}.cjs`), logLevel: "silent" });
  }, 60_000);

  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [join(dir, script), ...args], { env: { ...process.env, ...env } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
    });

  it("a tool script receives its argument file the way Forge-Code passes it", async () => {
    const r = await run("tool.cjs", [argsFile({ who: "world" })]);
    expect(r).toMatchObject({ code: 0, out: "hello world" });
  }, 30_000);

  it("a hook script blocks with exit code 2, which is what Forge-Code's hook runner treats as a block", async () => {
    const blocked = await run("hook.cjs", [], { FORGE_FILE: "keys.secret" });
    expect(blocked).toMatchObject({ code: 2, out: "do not touch keys.secret" });
    expect((await run("hook.cjs", [], { FORGE_FILE: "a.ts" })).code).toBe(0);
    // and the config that would point at it parses as a real hooks.json
    const { config, errors } = parseHooksConfig(JSON.stringify({ PreToolUse: [{ command: "node .forge/hooks/guard.cjs", matcher: "edit_file" }] }));
    expect(errors).toEqual([]);
    expect(config.PreToolUse).toHaveLength(1);
  }, 30_000);
});
