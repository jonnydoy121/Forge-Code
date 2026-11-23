// A schedule file (.forge/schedule.json): its jobs, and what is wrong with the ones that cannot be used. Pure, so the app and the CLI share it.
import { parseCron, type Cron } from "./cron";

export interface Job {
  name: string;
  cron: Cron;
  command: "ask" | "run";
  prompt: string;
  apply: boolean;
  allow: string[];
  maxCost?: number;
  maxSteps?: number;
  model?: string;
  provider?: string;
  baseUrl?: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;

/** The jobs in a schedule file, and what is wrong with the ones that are not usable (those are left out, not run half-configured). */
export function parseSchedule(text: string | null): { jobs: Job[]; errors: string[] } {
  const errors: string[] = [];
  if (text === null) return { jobs: [], errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { jobs: [], errors: [`the schedule is not valid JSON: ${(e as Error).message}`] };
  }
  const list = (raw as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(list)) return { jobs: [], errors: ['the schedule needs a "jobs" list'] };
  const jobs: Job[] = [];
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const j = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const label = typeof j.name === "string" && j.name ? `job "${j.name}"` : `job ${i + 1}`;
    const bad = (why: string) => void errors.push(`${label}: ${why}`);
    if (j.enabled === false) return;
    if (typeof j.name !== "string" || !NAME.test(j.name)) return bad("needs a name of letters, digits, - or _");
    if (seen.has(j.name)) return bad("the name is used twice");
    if (typeof j.prompt !== "string" || !j.prompt.trim()) return bad('needs a "prompt"');
    const command = j.command === undefined ? "ask" : j.command;
    if (command !== "ask" && command !== "run") return bad('"command" must be "ask" or "run"');
    if (j.apply !== undefined && typeof j.apply !== "boolean") return bad('"apply" must be true or false');
    if (j.apply === true && command !== "run") return bad('"apply" only makes sense with "command": "run"');
    if (j.allow !== undefined && (!Array.isArray(j.allow) || j.allow.some((a) => typeof a !== "string"))) return bad('"allow" must be a list of commands');
    if (j.allow !== undefined && command !== "run") return bad('"allow" only makes sense with "command": "run"');
    for (const k of ["maxCost", "maxSteps"] as const) if (j[k] !== undefined && !(typeof j[k] === "number" && (j[k] as number) > 0)) return bad(`"${k}" must be a positive number`);
    for (const k of ["model", "provider", "baseUrl"] as const) if (j[k] !== undefined && typeof j[k] !== "string") return bad(`"${k}" must be text`);
    let cron: Cron;
    try {
      if (typeof j.cron !== "string") throw new Error('needs a "cron" expression');
      cron = parseCron(j.cron);
    } catch (e) {
      return bad((e as Error).message);
    }
    seen.add(j.name);
    jobs.push({
      name: j.name,
      cron,
      command,
      prompt: j.prompt.trim(),
      apply: j.apply === true,
      allow: (j.allow as string[] | undefined) ?? [],
      maxCost: j.maxCost as number | undefined,
      maxSteps: j.maxSteps as number | undefined,
      model: j.model as string | undefined,
      provider: j.provider as string | undefined,
      baseUrl: j.baseUrl as string | undefined,
    });
  });
  return { jobs, errors };
}
