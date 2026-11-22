// Skills: `.forge/skills/<name>/SKILL.md` plus optional scripts and reference files in the same folder, from the
// repository and (optionally) from the user's own `~/.forge/skills`. The model sees an index (name and description),
// loads a skill's instructions with `use_skill`, and can run its bundled scripts with `run_skill_script`.
//
// A skill may declare typed entry points in `tools.json`:
//   { "bump.js": { "description": "Bump the version", "parameters": { "type": "object", "properties": { "level": { "type": "string", "enum": ["patch","minor","major"] } }, "required": ["level"] } } }
// The declared description is shown to the model and the arguments are validated against the schema before anything runs.
//
// Scripts are code, so running one is an execute-class tool call: the permission gate asks first, and in the desktop
// app it runs in the OS sandbox.

import type { RegisteredTool } from "@forge/tool-host";
import { parseFrontmatter } from "./frontmatter";

export interface ParamSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, ParamSchema & { description?: string }>;
  required?: string[];
  enum?: (string | number | boolean)[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

export interface ScriptDecl {
  description?: string;
  parameters?: ParamSchema;
}

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md without the front matter */
  body: string;
  /** where it came from: this repository, or the user's own skills folder */
  source: "project" | "user";
  /** absolute folder, forward slashes */
  dir: string;
  /** runnable files in the skill folder */
  scripts: string[];
  /** everything else in the folder (reference docs, templates), readable with read_file */
  files: string[];
  /** typed entry points declared in tools.json, by script name */
  declared: Record<string, ScriptDecl>;
  /** problems found in tools.json (shown so a broken declaration is not silently ignored) */
  problems: string[];
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
const TYPES = new Set(["object", "string", "number", "integer", "boolean", "array"]);

/** Validate declared tool parameters; returns what is wrong with them (empty = fine). */
export function checkSchema(s: unknown, where = "parameters"): string[] {
  if (s === undefined) return [];
  if (!s || typeof s !== "object" || Array.isArray(s)) return [`${where} must be an object`];
  const p = s as ParamSchema;
  const out: string[] = [];
  if (p.type !== undefined && !TYPES.has(p.type)) out.push(`${where}.type "${String(p.type)}" is not supported`);
  if (p.required !== undefined && (!Array.isArray(p.required) || p.required.some((r) => typeof r !== "string"))) out.push(`${where}.required must be a list of names`);
  for (const [k, v] of Object.entries(p.properties ?? {})) out.push(...checkSchema(v, `${where}.properties.${k}`));
  return out;
}

/** Check arguments against a declared schema (the subset above). Returns human-readable problems; empty = valid. */
export function validateArgs(schema: ParamSchema | undefined, args: unknown): string[] {
  if (!schema) return [];
  const problems: string[] = [];
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  for (const r of schema.required ?? []) if (a[r] === undefined || a[r] === null) problems.push(`missing required argument "${r}"`);
  for (const [k, v] of Object.entries(a)) {
    const def = schema.properties?.[k];
    if (!def) {
      if (schema.additionalProperties === false) problems.push(`unknown argument "${k}"`);
      continue;
    }
    const t = def.type;
    const ok = t === undefined || (t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : typeof v === t);
    if (!ok) {
      problems.push(`argument "${k}" must be ${t === "integer" ? "an integer" : `a ${t}`}`);
      continue;
    }
    if (def.enum && !def.enum.includes(v as never)) problems.push(`argument "${k}" must be one of: ${def.enum.join(", ")}`);
    if (typeof v === "string" && def.maxLength !== undefined && v.length > def.maxLength) problems.push(`argument "${k}" is longer than ${def.maxLength} characters`);
    if (typeof v === "number" && def.minimum !== undefined && v < def.minimum) problems.push(`argument "${k}" must be at least ${def.minimum}`);
    if (typeof v === "number" && def.maximum !== undefined && v > def.maximum) problems.push(`argument "${k}" must be at most ${def.maximum}`);
  }
  return problems;
}

/** One line per declared argument, for the model: `level (string, required, one of patch|minor|major)`. */
export function describeParams(schema: ParamSchema | undefined): string {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return "no arguments";
  return props
    .map(([k, d]) => {
      const bits = [d.type ?? "any", ...(schema?.required?.includes(k) ? ["required"] : []), ...(d.enum ? [`one of ${d.enum.join("|")}`] : [])];
      return `${k} (${bits.join(", ")})${d.description ? `: ${d.description}` : ""}`;
    })
    .join("; ");
}

async function loadFrom(fs: SkillFs, dir: string, source: Skill["source"]): Promise<Skill[]> {
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
    const scripts = entries.filter(isScript);

    const declared: Record<string, ScriptDecl> = {};
    const problems: string[] = [];
    const raw = entries.includes("tools.json") ? await fs.read(`${dir}/${name}/tools.json`).catch(() => null) : null;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Record<string, ScriptDecl>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object keyed by script name");
        for (const [script, decl] of Object.entries(parsed)) {
          if (!scripts.includes(script)) {
            problems.push(`tools.json declares "${script}", which is not a script in this skill`);
            continue;
          }
          const bad = checkSchema(decl?.parameters, `${script}.parameters`);
          if (bad.length) problems.push(...bad);
          else declared[script] = { description: typeof decl?.description === "string" ? decl.description : undefined, parameters: decl?.parameters };
        }
      } catch (e) {
        problems.push(`tools.json is not valid: ${(e as Error).message}`);
      }
    }
    out.push({ name, description, body: trimmed, source, dir: `${dir}/${name}`, scripts, files: entries.filter((f) => !isScript(f) && f !== "tools.json"), declared, problems });
  }
  return out;
}

/** Skills from the repository and, if given, the user's own folder. A project skill overrides a user skill of the same name. */
export async function loadSkills(fs: SkillFs, projectDir: string, userDir?: string): Promise<Skill[]> {
  const project = await loadFrom(fs, projectDir, "project");
  const user = userDir ? (await loadFrom(fs, userDir, "user")).filter((u) => !project.some((p) => p.name.toLowerCase() === u.name.toLowerCase())) : [];
  return [...project, ...user].sort((a, b) => a.name.localeCompare(b.name));
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
        d.audit?.({ name: `skill ${s.name}`, detail: `loaded (${s.source})` });
        const parts = [`# Skill: ${s.name}`, "", s.body];
        if (s.scripts.length && d.exec) {
          parts.push("", "Bundled scripts (run with run_skill_script):");
          for (const f of s.scripts) {
            const decl = s.declared[f];
            parts.push(`- ${f}${decl?.description ? `: ${decl.description}` : ""}${decl ? ` | args: ${describeParams(decl.parameters)}` : ""}`);
          }
        }
        if (s.files.length) parts.push("", `Other files in ${s.dir} (read with read_file): ${s.files.join(", ")}`);
        if (s.problems.length) parts.push("", `Note: this skill's tools.json has problems: ${s.problems.join("; ")}`);
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
          "Run a script bundled with a skill. The script is code from this repository (or the user's own skills); the developer is asked before it runs. It starts in the workspace root and receives ONE command-line argument: the path of a JSON file containing the `args` object you pass here (read it with the script's own file APIs). If the skill declares the script's arguments they are checked first. Scripts run with a time limit and, in the desktop app, in the OS sandbox with no network.",
        parameters: { type: "object", properties: { skill: { type: "string" }, script: { type: "string" }, args: { type: "object" }, timeout_seconds: { type: "number" } }, required: ["skill", "script"] },
        class: "execute",
      },
      async run(args) {
        const s = await find(args.skill);
        const script = typeof args.script === "string" ? args.script : "";
        if (!s.scripts.includes(script)) throw new Error(`skill ${s.name} has no script ${JSON.stringify(script)}. Scripts: ${s.scripts.join(", ") || "(none)"}`);
        const given = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? (args.args as Record<string, unknown>) : {};
        const bad = validateArgs(s.declared[script]?.parameters, given);
        if (bad.length) throw new Error(`the arguments do not match what ${s.name}/${script} declares: ${bad.join("; ")}. Expected: ${describeParams(s.declared[script]?.parameters)}`);
        const path = `${s.dir}/${script}`;
        if (UNSAFE_IN_COMMAND.test(path)) throw new Error("refused: the skill path contains characters that cannot be passed safely to a script runner");
        const payload = JSON.stringify(given);
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
        d.audit?.({ name: `skill ${s.name}/${script}`, detail: `${s.source} skill, ${sandbox ? "sandboxed" : "NOT sandboxed"}` });
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
