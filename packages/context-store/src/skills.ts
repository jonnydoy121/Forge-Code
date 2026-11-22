// Skills: `.forge/skills/<name>/SKILL.md` plus optional scripts and reference files in the same folder.
// The model sees an index (name and description), loads a skill's instructions with `use_skill`, and can run its bundled
// scripts with `run_skill_script`. Scripts are code from the repository, so running one is an execute-class tool call:
// the permission gate asks first, and in the desktop app it runs in the OS sandbox.

import type { RegisteredTool } from "@forge/tool-host";
import { parseFrontmatter } from "./frontmatter";

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md without the front matter */
  body: string;
  /** runnable files in the skill folder */
  scripts: string[];
  /** everything else in the folder (reference docs, templates), readable with read_file */
  files: string[];
}

export interface SkillFs {
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
  write?(path: string, content: string): Promise<void>;
  remove?(path: string): Promise<void>;
}

export interface SkillExec {
  run(command: string, opts: { cwd: string; timeoutMs: number; sandbox?: boolean; toolchainRead?: boolean }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; sandbox?: { mode: string; warnings?: string[] } }>;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
/** extension -> interpreter. Anything else in a skill folder is a reference file, not runnable. */
const INTERPRETERS: Record<string, string> = { js: "node", mjs: "node", cjs: "node", py: "python", sh: "sh" };
const extOf = (f: string) => f.split(".").pop()?.toLowerCase() ?? "";
const isScript = (f: string) => f.includes(".") && f !== "SKILL.md" && extOf(f) in INTERPRETERS && /^[\w.-]+$/.test(f);
/** Characters that would let a path break out of the double-quoted command line. */
const UNSAFE_IN_COMMAND = /["`$%&|;<>^!'\r\n]/;

export async function loadSkills(fs: SkillFs, dir: string): Promise<Skill[]> {
  let names: string[] = [];
  try {
    names = await fs.list(dir);
  } catch {
    return []; // no skills folder
  }
  const out: Skill[] = [];
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const text = await fs.read(`${dir}/${name}/SKILL.md`).catch(() => null);
    if (text === null) continue; // not a skill folder
    const { data, body } = parseFrontmatter(text);
    const trimmed = body.trim();
    if (!trimmed) continue;
    const description = typeof data.description === "string" && data.description ? data.description : trimmed.split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 120);
    const entries = (await fs.list(`${dir}/${name}`).catch(() => [] as string[])).filter((f) => f !== "SKILL.md").sort();
    out.push({ name, description, body: trimmed, scripts: entries.filter(isScript), files: entries.filter((f) => !isScript(f)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The index shown to the model every turn: just enough to know a skill exists. */
export function skillsIndex(skills: Skill[]): string {
  return skills.map((s) => `- ${s.name}: ${s.description}${s.scripts.length ? ` (has scripts: ${s.scripts.join(", ")})` : ""}`).join("\n");
}

const tail = (s: string, n: number) => (s.length > n ? `[... ${s.length - n} earlier characters omitted]\n${s.slice(-n)}` : s);

export interface SkillToolDeps {
  /** workspace root, forward slashes */
  root: string;
  fs: SkillFs;
  /** read the skills fresh on every call, so edits to a skill take effect immediately */
  skills(): Promise<Skill[]>;
  /** without it only `use_skill` is offered (instructions, no scripts) */
  exec?: SkillExec;
  sandbox?: () => boolean;
  toolchainRead?: () => boolean;
  audit?: (e: { name: string; detail?: string; blocked?: boolean }) => void;
}

export function createSkillTools(d: SkillToolDeps): RegisteredTool[] {
  const skillDir = (name: string) => `${d.root.replace(/\/+$/, "")}/.forge/skills/${name}`;
  const find = async (name: unknown) => {
    const all = await d.skills();
    const s = typeof name === "string" ? all.find((x) => x.name.toLowerCase() === name.toLowerCase()) : undefined;
    if (!s) throw new Error(`no skill named ${JSON.stringify(name)}. Available: ${all.map((x) => x.name).join(", ") || "(none)"}`);
    return s;
  };

  const tools: RegisteredTool[] = [
    {
      spec: {
        name: "use_skill",
        description: "Load a skill's full instructions by name. The skills you can use are listed in your context. Do this before starting a task a skill covers.",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        class: "read",
      },
      async run(args) {
        const s = await find(args.name);
        d.audit?.({ name: `skill ${s.name}`, detail: "loaded" });
        const parts = [`# Skill: ${s.name}`, "", s.body];
        if (s.scripts.length && d.exec) parts.push("", `Bundled scripts (run with run_skill_script): ${s.scripts.join(", ")}`);
        if (s.files.length) parts.push("", `Other files in .forge/skills/${s.name}/ (read with read_file): ${s.files.join(", ")}`);
        return parts.join("\n");
      },
    },
  ];

  if (d.exec) {
    const exec = d.exec;
    tools.push({
      spec: {
        name: "run_skill_script",
        description:
          "Run a script bundled with a skill. The script is code from this repository; the developer is asked before it runs. It starts in the workspace root and receives ONE command-line argument: the path of a JSON file containing the `args` object you pass here (read it with the script's own file APIs). Scripts run with a time limit and, in the desktop app, in the OS sandbox with no network.",
        parameters: { type: "object", properties: { skill: { type: "string" }, script: { type: "string" }, args: { type: "object" }, timeout_seconds: { type: "number" } }, required: ["skill", "script"] },
        class: "execute",
      },
      async run(args) {
        const s = await find(args.skill);
        const script = typeof args.script === "string" ? args.script : "";
        if (!s.scripts.includes(script)) throw new Error(`skill ${s.name} has no script ${JSON.stringify(script)}. Scripts: ${s.scripts.join(", ") || "(none)"}`);
        const path = `${skillDir(s.name)}/${script}`;
        if (UNSAFE_IN_COMMAND.test(path)) throw new Error("refused: the workspace path contains characters that cannot be passed safely to a script runner");
        const payload = JSON.stringify(args.args && typeof args.args === "object" ? args.args : {});
        if (payload.length > 20_000) throw new Error("args are too large (limit 20,000 characters)");

        // Arguments travel in a small file inside the workspace (the sandbox can read it): there is no shell quoting of
        // model-supplied text anywhere, so nothing in `args` can alter the command line.
        let argsFile: string | null = null;
        if (d.fs.write) {
          argsFile = `${d.root.replace(/\/+$/, "")}/.forge/skill-runs/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`;
          await d.fs.write(argsFile, payload);
        }
        const interpreter = INTERPRETERS[extOf(script)]!;
        const command = `${interpreter} "${path}"${argsFile ? ` "${argsFile}"` : ""}`;
        const timeoutMs = Math.min(300, Math.max(1, typeof args.timeout_seconds === "number" ? args.timeout_seconds : 60)) * 1000;
        const sandbox = d.sandbox?.() ?? true;
        d.audit?.({ name: `skill ${s.name}/${script}`, detail: sandbox ? "sandboxed" : "NOT sandboxed" });
        try {
          const r = await exec.run(command, { cwd: d.root, timeoutMs, sandbox, toolchainRead: d.toolchainRead?.() ?? true });
          d.audit?.({ name: `skill ${s.name}/${script}`, detail: r.timedOut ? "timed out" : `exit ${r.code}` });
          const lines = [r.timedOut ? "The script timed out and was killed." : `exit code ${r.code}`];
          if (r.sandbox) lines.push(r.sandbox.mode === "appcontainer" ? "(ran in the OS sandbox: workspace only, no network)" : "(ran with a scrubbed environment; no OS sandbox was available)");
          if (r.stdout.trim()) lines.push("--- stdout ---", tail(r.stdout.trim(), 6000));
          if (r.stderr.trim()) lines.push("--- stderr ---", tail(r.stderr.trim(), 3000));
          for (const w of r.sandbox?.warnings ?? []) lines.push(`note: ${w}`);
          return lines.join("\n");
        } finally {
          if (argsFile) await d.fs.remove?.(argsFile).catch(() => {});
        }
      },
    });
  }
  return tools;
}
