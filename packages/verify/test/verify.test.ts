import { describe, expect, it } from "vitest";
import {
  HookRunner,
  detectWeakening,
  discoverCommands,
  feedbackMessage,
  fillTemplate,
  finalFailureMessage,
  loadCommands,
  parseCommandsSection,
  parseHooksConfig,
  renderCommandsSection,
  runChecks,
  withCommandsSection,
  type DiscoveryFs,
  type Exec,
  type ExecResult,
  type ProjectCommands,
} from "../src";

const memFs = (files: Record<string, string>): DiscoveryFs => ({
  read: async (p) => files[p] ?? null,
  list: async (d) => Object.keys(files).filter((k) => k.startsWith(d + "/")).map((k) => k.slice(d.length + 1)).filter((n) => !n.includes("/")),
});

describe("discoverCommands", () => {
  it("reads package.json scripts and picks the package manager from the lockfile", async () => {
    const c = await discoverCommands(
      memFs({
        "/r/package.json": JSON.stringify({ scripts: { build: "tsc", lint: "eslint .", test: "vitest run", typecheck: "tsc -b", dev: "vite", "format:check": "prettier --check ." }, devDependencies: { vitest: "^2" } }),
        "/r/pnpm-lock.yaml": "",
      }),
      "/r",
    );
    expect(c).toMatchObject({ build: "pnpm run build", lint: "pnpm run lint", test: "pnpm test", typecheck: "pnpm run typecheck", dev: "pnpm run dev", format: "pnpm run format:check", testFile: "npx vitest run {file}" });
    expect(c.sources.lint).toBe("package.json scripts.lint");
  });

  it("ignores the npm placeholder test script and falls back to tsc for typecheck", async () => {
    const c = await discoverCommands(memFs({ "/r/package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' }, devDependencies: { typescript: "5" } }), "/r/tsconfig.json": "{}" }), "/r");
    expect(c.test).toBeUndefined();
    expect(c.typecheck).toBe("npx tsc --noEmit");
  });

  it("detects Makefile, pyproject, Cargo and go.mod projects", async () => {
    expect(await discoverCommands(memFs({ "/r/Makefile": "build:\n\tgo build\ntest:\n\tgo test\nlint:\n\tx\n" }), "/r")).toMatchObject({ build: "make build", test: "make test", lint: "make lint" });
    expect(await discoverCommands(memFs({ "/r/pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n" }), "/r")).toMatchObject({ test: "pytest", testFile: "pytest {file}", lint: "ruff check .", typecheck: "mypy ." });
    expect(await discoverCommands(memFs({ "/r/Cargo.toml": "[package]" }), "/r")).toMatchObject({ typecheck: "cargo check", test: "cargo test", lint: "cargo clippy -- -D warnings" });
    expect(await discoverCommands(memFs({ "/r/go.mod": "module x" }), "/r")).toMatchObject({ test: "go test ./...", typecheck: "go vet ./..." });
  });

  it("uses CI run steps as a last resort, skipping installs", async () => {
    const c = await discoverCommands(memFs({ "/r/.github/workflows/ci.yml": "steps:\n  - run: npm ci\n  - run: npm run lint\n  - run: npm test\n" }), "/r");
    expect(c).toMatchObject({ lint: "npm run lint", test: "npm test" });
    expect(c.sources.lint).toBe(".github/workflows/ci.yml");
  });

  it("returns nothing for an empty project", async () => {
    expect(await discoverCommands(memFs({}), "/r")).toEqual({ sources: {} });
  });
});

describe("rules file round trip", () => {
  const cmds: ProjectCommands = { build: "npm run build", test: "npm test", testFile: "npx vitest run {file}", sources: {} };
  it("renders and parses the ## Commands section", () => {
    const md = `# Rules\n\nBe nice.\n\n${renderCommandsSection(cmds)}\n## Other\n- x: y\n`;
    expect(parseCommandsSection(md)).toEqual({ build: "npm run build", test: "npm test", testFile: "npx vitest run {file}" });
  });
  it("developer corrections override detection and are never overwritten", async () => {
    const md = "# R\n\n## Commands\n- test: make check\n- lint: `ruff check src`\n";
    expect(withCommandsSection(md, cmds)).toBeNull(); // already has a section
    const c = await loadCommands(memFs({ "/r/package.json": JSON.stringify({ scripts: { test: "vitest" } }), "/r/AGENTS.md": md }), "/r");
    expect(c.test).toBe("make check");
    expect(c.lint).toBe("ruff check src");
    expect(c.sources.test).toBe("AGENTS.md ## Commands");
  });
  it("creates or appends a section when missing", () => {
    expect(withCommandsSection(null, cmds)).toMatch(/^# AGENTS\.md\n\n## Commands/);
    expect(withCommandsSection("# R\n\ntext", cmds)).toMatch(/# R\n\ntext\n\n## Commands/);
  });
});

// ---- checks ----

const ok: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false, millis: 5 };
function fakeExec(handler: (cmd: string) => Partial<ExecResult>) {
  const calls: string[] = [];
  const exec: Exec = { run: async (cmd) => (calls.push(cmd), { ...ok, ...handler(cmd) }) };
  return { exec, calls };
}
const cmds: ProjectCommands = { lint: "npm run lint", typecheck: "npm run typecheck", test: "npm test", testFile: "npx vitest run {file}", format: "prettier --check {files}", sources: {} };

describe("fillTemplate", () => {
  it("quotes paths and refuses unsafe ones", () => {
    expect(fillTemplate("fmt {files}", ["a b.ts", "c.ts"])).toBe('fmt "a b.ts" "c.ts"');
    expect(fillTemplate("fmt {files}", ['x";rm -rf /.ts', "a$(id).ts"])).toBeNull();
    expect(fillTemplate("npm test", [])).toBe("npm test");
  });
});

describe("runChecks", () => {
  it("fast phase scopes format to touched files and runs only related tests; reports passes", async () => {
    const { exec, calls } = fakeExec(() => ({}));
    const r = await runChecks({
      commands: cmds,
      exec,
      cwd: "/r",
      phase: "fast",
      touched: [{ path: "src/a.ts", created: false }, { path: "src/a.test.ts", created: true }],
      relatedTests: async (fs) => (fs.includes("src/a.ts") ? ["src/a.test.ts"] : []),
    });
    expect(calls).toEqual(['prettier --check "src/a.ts" "src/a.test.ts"', "npm run lint", "npm run typecheck", 'npx vitest run "src/a.test.ts"']);
    expect(r.verified).toBe(false); // only a full run can claim Verified
    expect(r.testsAdded).toEqual(["src/a.test.ts"]);
    expect(r.summary).toContain("Fast checks passed");
  });

  it("full phase runs the whole suite and labels Verified only when everything passes", async () => {
    const pass = await runChecks({ commands: cmds, exec: fakeExec(() => ({})).exec, cwd: "/r", phase: "full", touched: [{ path: "src/a.ts", created: false }], relatedTests: async () => ["t"] });
    expect(pass.verified).toBe(true);
    expect(pass.checks.at(-1)).toMatchObject({ kind: "test", command: "npm test" });
    const fail = await runChecks({ commands: cmds, exec: fakeExec((c) => (c === "npm test" ? { code: 1, stdout: "FAILED tests/t.py::test_x - AssertionError: bad" } : {})).exec, cwd: "/r", phase: "full", touched: [{ path: "src/a.ts", created: false }], relatedTests: async () => ["t"] });
    expect(fail.verified).toBe(false);
    expect(fail.summary).toContain("Failed: test (1)");
    expect(fail.checks.at(-1)!.errors[0]).toMatchObject({ test: "test_x" });
  });

  it("parses failures into structured errors and falls back to a raw tail only when nothing parses", async () => {
    const { exec } = fakeExec((c) => (c === "npm run typecheck" ? { code: 2, stderr: "src/a.ts(3,1): error TS2304: Cannot find name 'x'." } : c === "npm run lint" ? { code: 1, stdout: "weird unparseable output" } : {}));
    const r = await runChecks({ commands: cmds, exec, cwd: "/r", phase: "fast", touched: [{ path: "src/a.ts", created: false }] });
    expect(r.checks.find((k) => k.kind === "typecheck")!.errors[0]).toMatchObject({ file: "src/a.ts", line: 3, rule: "TS2304" });
    const lint = r.checks.find((k) => k.kind === "lint")!;
    expect(lint.errors).toEqual([]);
    expect(lint.rawTail).toContain("unparseable");
  });

  it("treats timeouts as failures", async () => {
    const r = await runChecks({ commands: { test: "npm test", sources: {} }, exec: fakeExec(() => ({ code: null, timedOut: true })).exec, cwd: "/r", phase: "full", touched: [] });
    expect(r.checks[0]).toMatchObject({ ok: false });
    expect(r.checks[0]!.rawTail).toContain("timed out");
  });

  it("reports what could not be verified: missing commands and untested files", async () => {
    const r = await runChecks({ commands: { test: "npm test", sources: {} }, exec: fakeExec(() => ({})).exec, cwd: "/r", phase: "full", touched: [{ path: "src/x.ts", created: false }], relatedTests: async () => [] });
    expect(r.unverified).toEqual(expect.arrayContaining(["no lint command configured (add it under ## Commands in AGENTS.md)", "no tests cover src/x.ts"]));
  });

  it("is never Verified when no checks ran", async () => {
    const r = await runChecks({ commands: { sources: {} }, exec: fakeExec(() => ({})).exec, cwd: "/r", phase: "full", touched: [] });
    expect(r.verified).toBe(false);
    expect(r.summary).toContain("Unverified");
  });

  it("includes LSP diagnostics as a check", async () => {
    const r = await runChecks({ commands: { sources: {} }, exec: fakeExec(() => ({})).exec, cwd: "/r", phase: "fast", touched: [{ path: "a.ts", created: false }], diagnostics: async () => [{ message: "bad", severity: "error", file: "a.ts", line: 1 }] });
    expect(r.checks[0]).toMatchObject({ kind: "diagnostics", ok: false });
  });
});

describe("feedback messages", () => {
  it("lists structured errors and forbids weakening tests", async () => {
    const r = await runChecks({ commands: { test: "npm test", sources: {} }, exec: fakeExec(() => ({ code: 1, stdout: "FAILED t.py::test_a - AssertionError: 1 != 2" })).exec, cwd: "/r", phase: "full", touched: [] });
    const m = feedbackMessage(r, 2, 5);
    expect(m).toContain("attempt 2 of 5");
    expect(m).toContain("FAILED test (npm test): 1 problem(s)");
    expect(m).toContain("t.py (test_a) AssertionError: 1 != 2");
    expect(m).toContain("Do NOT delete, skip or weaken tests");
    expect(finalFailureMessage(r, 5)).toContain("best hypothesis");
  });
});

describe("detectWeakening", () => {
  it("flags added suppressions", () => {
    expect(detectWeakening("src/a.ts", "const a = b;", "// @ts-ignore\nconst a = b;")).toEqual(["adds a TypeScript suppression"]);
    expect(detectWeakening("a.py", "x = 1", "x = 1  # noqa")).toEqual(["adds a Python lint/type suppression"]);
    expect(detectWeakening("a.ts", "f()", "// eslint-disable-next-line\nf()")).toContain("adds an eslint-disable");
  });
  it("flags skipped tests, removed assertions and weaker matchers in test files", () => {
    expect(detectWeakening("a.test.ts", "it('x', () => {})", "it.skip('x', () => {})")).toContain("skips a test");
    expect(detectWeakening("a.test.ts", "expect(a).toBe(1);\nexpect(b).toBe(2);", "expect(a).toBe(1);")).toContain("removes 1 assertion from a test file");
    expect(detectWeakening("test_a.py", "assert x == 1", "assert x")).toEqual([]); // not detectable heuristically
    expect(detectWeakening("a.test.ts", "expect(a).toBe(3);", "expect(a).toBeTruthy();")).toContain("replaces an assertion with a weaker one");
    expect(detectWeakening("a.test.ts", "x", null)).toEqual(["deletes a test file"]);
  });
  it("leaves legitimate edits alone, including fixing source and adding tests", () => {
    expect(detectWeakening("src/sum.ts", "return a - b;", "return a + b;")).toEqual([]);
    expect(detectWeakening("a.test.ts", "expect(a).toBe(1);", "expect(a).toBe(1);\nexpect(b).toBe(2);")).toEqual([]);
    expect(detectWeakening("src/a.ts", "x", "// this mentions eslint only in prose")).toEqual([]);
  });
});

describe("hooks", () => {
  it("rejects bad configs with clear messages", () => {
    expect(parseHooksConfig("{nope").errors[0]).toContain("not valid JSON");
    const { config, errors } = parseHooksConfig(JSON.stringify({ PostEdit: [{ command: "fmt" }, { nope: 1 }], Bogus: [], Stop: "x" }));
    expect(config.PostEdit).toEqual([{ command: "fmt", matcher: undefined, timeoutMs: undefined }]);
    expect(errors).toHaveLength(3);
    expect(parseHooksConfig(null)).toEqual({ config: {}, errors: [] });
  });

  it("passes context via environment, filters by matcher, and maps exit codes", async () => {
    const seen: { cmd: string; env?: Record<string, string> }[] = [];
    const exec: Exec = {
      run: async (cmd, o) => {
        seen.push({ cmd, env: o.env });
        return { ...ok, code: cmd === "block" ? 2 : cmd === "warn" ? 1 : 0, stdout: cmd === "fmt" ? "formatted" : cmd === "block" ? "no secrets in commits" : "" };
      },
    };
    const runner = new HookRunner({ cwd: "/r", exec, config: parseHooksConfig(JSON.stringify({ PostEdit: [{ command: "fmt", matcher: "*.ts" }, { command: "py", matcher: "*.py" }], PreToolUse: [{ command: "block", matcher: "run_checks" }, { command: "warn" }] })).config });
    const edit = await runner.run("PostEdit", { files: ["src/a.ts"] });
    expect(edit).toEqual({ ran: 1, blocked: false, output: "formatted" });
    expect(seen[0]!.env).toMatchObject({ FORGE_EVENT: "PostEdit", FORGE_FILE: "src/a.ts", FORGE_FILES: "src/a.ts" });
    const pre = await runner.run("PreToolUse", { tool: "run_checks" });
    expect(pre.blocked).toBe(true);
    expect(pre.output).toContain("no secrets in commits");
    expect(pre.output).toContain('[hook "warn" exited 1]');
    expect((await runner.run("PreToolUse", { tool: "read_file" })).ran).toBe(1); // only the unmatched-by-glob "warn" hook
    expect(await runner.run("Stop")).toEqual({ ran: 0, blocked: false, output: "" });
  });
});
