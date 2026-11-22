// forge-code: the Forge-Code agent from the command line. Review-first like the desktop app: `run` prints the diffs it
// would make and writes nothing unless you pass --apply. Read-only `ask` never edits. No shell commands are offered.

import { resolve } from "node:path";
import { Gateway, type ProviderConfig } from "@forge/model-gateway";
import { Runtime } from "@forge/agent-runtime";
import { READ_TOOLS, createEditTools, createToolHost, type EditSink } from "@forge/tool-host";
import { PendingChanges } from "@forge/review";
import { InMemoryCheckpointStore } from "@forge/checkpoints";
import type { ModelGateway } from "@forge/protocol";
import { diskFs, promptFs, toolFs } from "./nodefs";
import { headlessCommandTools } from "./commands";
import { createSkillTools, expandPrompt, loadPrompts, loadSkills, skillsIndex } from "@forge/context-store";
import { unifiedDiff } from "./format";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** tests inject a scripted gateway; production builds a real one */
  gateway?: ModelGateway;
}

export interface Options {
  command: "ask" | "run";
  prompt: string;
  provider: ProviderConfig["kind"];
  model: string | undefined;
  baseUrl: string | undefined;
  apply: boolean;
  /** commands the agent may run (exact, or a trailing * for any arguments) */
  allow: string[];
  json: boolean;
  maxSteps: number;
  maxCostUsd: number;
}

export const USAGE = `forge-code: the Forge-Code agent from the command line

Usage:
  forge-code ask "question about this repo"        read-only, never edits
  forge-code run "task to carry out"               proposes edits and prints them as diffs (writes nothing)
  forge-code run "task" --apply                    ...and writes the changes to disk

Options:
  --model <name>        model to use (or FORGE_MODEL)
  --provider <kind>     ollama (default), openai or anthropic (or FORGE_PROVIDER)
  --base-url <url>      API base URL (or FORGE_BASE_URL)
  --allow <command>     let the agent run this command (repeatable; a trailing * allows any arguments but never
                        chained or redirected commands). Nothing runs unless allowed, e.g. --allow "npm test"
  --max-steps <n>       tool-use steps before stopping (default 12)
  --max-cost <usd>      spending limit for the run (default 2)
  --json                machine-readable result on stdout
  -h, --help            this text

The API key is read from FORGE_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY and is never accepted as a flag.
Exit codes: 0 done, 1 error, 2 stopped at a limit.
`;

const KINDS = ["ollama", "openai", "anthropic"] as const;

export function parseArgs(argv: string[], env: Record<string, string | undefined>): Options | { error: string } | { help: true } {
  const o: Options = {
    command: "ask",
    prompt: "",
    provider: "ollama",
    model: env.FORGE_MODEL,
    baseUrl: env.FORGE_BASE_URL,
    apply: false,
    allow: [],
    json: false,
    maxSteps: 12,
    maxCostUsd: 2,
  };
  if (env.FORGE_PROVIDER) {
    if (!(KINDS as readonly string[]).includes(env.FORGE_PROVIDER)) return { error: `FORGE_PROVIDER must be one of ${KINDS.join(", ")}` };
    o.provider = env.FORGE_PROVIDER as Options["provider"];
  }
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "-h" || a === "--help") return { help: true };
      else if (a === "--apply") o.apply = true;
      else if (a === "--json") o.json = true;
      else if (a === "--allow") o.allow.push(value());
      else if (a === "--model") o.model = value();
      else if (a === "--base-url") o.baseUrl = value();
      else if (a === "--provider") {
        const v = value();
        if (!(KINDS as readonly string[]).includes(v)) return { error: `--provider must be one of ${KINDS.join(", ")}` };
        o.provider = v as Options["provider"];
      } else if (a === "--max-steps") {
        const n = Math.floor(Number(value()));
        if (!(n >= 1)) return { error: "--max-steps must be a whole number of at least 1" };
        o.maxSteps = n;
      } else if (a === "--max-cost") {
        const n = Number(value());
        if (!(n > 0)) return { error: "--max-cost must be a positive number of dollars" };
        o.maxCostUsd = n;
      }
      else if (a.startsWith("-")) return { error: `unknown option ${a}` };
      else rest.push(a);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  const [cmd, ...words] = rest;
  if (cmd !== "ask" && cmd !== "run") return { error: cmd ? `unknown command "${cmd}" (expected ask or run)` : "missing command (ask or run)" };
  o.command = cmd;
  o.prompt = words.join(" ").trim();
  if (!o.prompt) return { error: `"${cmd}" needs a prompt` };
  if (o.apply && cmd === "ask") return { error: "--apply only makes sense with run" };
  if (o.allow.length && cmd === "ask") return { error: "--allow only makes sense with run" };
  return o;
}

export async function runCli(argv: string[], io: Io): Promise<number> {
  const parsed = parseArgs(argv, io.env);
  if ("help" in parsed) return io.out(USAGE), 0;
  if ("error" in parsed) return io.err(`forge-code: ${parsed.error}\n\n${USAGE}`), 1;
  const o = parsed;
  if (!o.model && !io.gateway) return io.err("forge-code: no model given. Pass --model or set FORGE_MODEL.\n"), 1;

  const root = resolve(io.cwd).replace(/[\\]/g, "/");
  const gateway =
    io.gateway ??
    (() => {
      const g = new Gateway({ fetch: (u, i) => fetch(u, i as RequestInit) as never });
      g.register("default", { kind: o.provider, baseUrl: o.baseUrl, apiKey: io.env.FORGE_API_KEY ?? (o.provider === "anthropic" ? io.env.ANTHROPIC_API_KEY : o.provider === "openai" ? io.env.OPENAI_API_KEY : undefined) });
      return g;
    })();

  // A saved prompt (.forge/prompts/<name>.md) can be invoked as: forge-code run "/name arguments"
  const slash = expandPrompt(o.prompt, await loadPrompts(promptFs, `${root}/.forge/prompts`));
  if (slash) {
    o.prompt = slash.prompt;
    if (!o.json) io.err(`  using saved prompt /${slash.name}\n`);
  }

  const pending = new PendingChanges({ fs: diskFs, checkpoints: new InMemoryCheckpointStore(), mode: () => "review" });
  const sink: EditSink = {
    read: async (p) => {
      const e = pending.effective(p);
      return e !== undefined ? e : diskFs.read(p);
    },
    propose: async (path, proposed, reason) => {
      const r = await pending.propose(path, proposed, reason);
      return { status: r.status, added: r.stats.added, removed: r.stats.removed, checkpoint: r.checkpoint, created: r.created, warnings: r.warnings };
    },
  };
  // Skills (.forge/skills): instructions only. The CLI has no OS sandbox, so bundled scripts are never offered here.
  const skillFs = { read: promptFs.read, list: promptFs.list };
  const home = (io.env.HOME ?? io.env.USERPROFILE)?.replace(/[\\]/g, "/").replace(/\/+$/, "");
  const userSkills = home ? `${home}/.forge/skills` : undefined;
  const skills = await loadSkills(skillFs, `${root}/.forge/skills`, userSkills);
  const skillTools = skills.length ? createSkillTools({ root, fs: skillFs, skills: () => loadSkills(skillFs, `${root}/.forge/skills`, userSkills) }) : [];
  const tools = createToolHost({ root, fs: toolFs, tools: o.command === "run" ? [...READ_TOOLS, ...skillTools, ...createEditTools(sink), ...(o.allow.length ? headlessCommandTools(root, o.allow, (l) => void (!o.json && io.err(`  $ ${l}\n`))) : [])] : [...READ_TOOLS, ...skillTools] });
  const runtime = new Runtime({ gateway, tools, provider: "default", model: o.model ?? "scripted", limits: { maxSteps: o.maxSteps, maxCostUsd: o.maxCostUsd, maxSeconds: 900 },
    sections: skills.length ? () => [{ id: "skills", label: "Skills available (load one with use_skill before a task it covers)", priority: 3, text: skillsIndex(skills) }] : undefined,
  });

  let answer = "";
  let stop: string | null = null;
  try {
    for await (const ev of runtime.run({ mode: o.command === "run" ? "agent" : "ask", prompt: o.prompt })) {
      if (ev.type === "text") {
        answer += ev.delta;
        if (!o.json) io.out(ev.delta);
      } else if (ev.type === "tool_call") {
        if (!o.json) io.err(`  • ${ev.call.name} ${JSON.stringify(ev.call.args).slice(0, 120)}\n`);
      } else if (ev.type === "limit") {
        stop = ev.reason;
      }
    }
  } catch (e) {
    io.err(`forge-code: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const files = pending.list().map((f) => ({ path: f.path.startsWith(root + "/") ? f.path.slice(root.length + 1) : f.path, abs: f.path, added: f.stats.added, removed: f.stats.removed, diff: unifiedDiff(f.path.startsWith(root + "/") ? f.path.slice(root.length + 1) : f.path, f.base, f.hunks) }));
  if (o.apply) for (const f of files) await pending.resolveAll(f.abs, "accepted");

  if (o.json) {
    io.out(JSON.stringify({ answer, applied: o.apply, stopped: stop, costUsd: runtime.costUsd, files: files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, diff: f.diff })) }, null, 2) + "\n");
  } else {
    io.out("\n");
    if (o.command === "run") {
      if (files.length === 0) io.out("No file changes.\n");
      for (const f of files) io.out(`\n${f.diff}\n`);
      if (files.length) io.out(o.apply ? `\nApplied ${files.length} file(s).\n` : `\n${files.length} file(s) proposed, nothing written. Re-run with --apply to write them.\n`);
    }
    if (stop) io.err(`forge-code: stopped at the ${stop} limit\n`);
  }
  return stop ? 2 : 0;
}
