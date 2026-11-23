// Editing .forge/schedule.json from the app. Works on the raw jobs so fields this screen does not show (allow, maxCost, model...) and
// disabled jobs survive a save. Every change is checked with the same parser the command line uses before it is written.
import { nextRun, parseSchedule } from "@forge/context-store";

export interface RawJob {
  name: string;
  cron: string;
  prompt: string;
  command?: string;
  apply?: boolean;
  enabled?: boolean;
  [other: string]: unknown;
}

export function readRaw(text: string | null): { jobs: RawJob[]; error?: string } {
  if (text === null || !text.trim()) return { jobs: [] };
  try {
    const j = JSON.parse(text) as { jobs?: unknown };
    if (!Array.isArray(j?.jobs)) return { jobs: [], error: 'The file needs a "jobs" list.' };
    return { jobs: j.jobs.filter((x): x is RawJob => !!x && typeof x === "object") };
  } catch (e) {
    return { jobs: [], error: `The file is not valid JSON: ${(e as Error).message}` };
  }
}

const serialize = (jobs: RawJob[]) => `${JSON.stringify({ jobs }, null, 2)}\n`;

/** Why this job cannot be used, or null. Uses the command line's own validation. */
export function validateJob(job: RawJob): string | null {
  const { errors } = parseSchedule(JSON.stringify({ jobs: [{ ...job, enabled: true }] }));
  return errors.length ? errors[0]!.replace(/^job "[^"]*": |^job \d+: /, "") : null;
}

export interface JobView {
  job: RawJob;
  enabled: boolean;
  problem: string | null;
  /** next time it runs (local time), when it is enabled and valid */
  next: Date | null;
}

export function describeJobs(text: string | null, now: Date): { views: JobView[]; error?: string } {
  const { jobs, error } = readRaw(text);
  const seen = new Set<string>();
  const views = jobs.map((job) => {
    const enabled = job.enabled !== false;
    let problem = validateJob(job);
    if (!problem && typeof job.name === "string") {
      if (seen.has(job.name)) problem = "the name is used twice";
      seen.add(job.name);
    }
    const parsed = !problem ? parseSchedule(JSON.stringify({ jobs: [{ ...job, enabled: true }] })).jobs[0] : undefined;
    return { job, enabled, problem, next: enabled && parsed ? nextRun(parsed.cron, now) : null };
  });
  return { views, error };
}

export type EditResult = { text: string } | { error: string };

/** Add a job, or (with `replacing`) change the one with that name. The file is only changed if the result is valid. */
export function saveJob(text: string | null, job: RawJob, replacing?: string): EditResult {
  const { jobs, error } = readRaw(text);
  if (error) return { error };
  const problem = validateJob(job);
  if (problem) return { error: problem };
  if (jobs.some((j) => j.name === job.name && j.name !== replacing)) return { error: `there is already a job called "${job.name}"` };
  const next = replacing ? jobs.map((j) => (j.name === replacing ? { ...j, ...job } : j)) : [...jobs, job];
  return { text: serialize(next) };
}

export function removeJob(text: string | null, name: string): EditResult {
  const { jobs, error } = readRaw(text);
  if (error) return { error };
  return { text: serialize(jobs.filter((j) => j.name !== name)) };
}

export function setEnabled(text: string | null, name: string, enabled: boolean): EditResult {
  const { jobs, error } = readRaw(text);
  if (error) return { error };
  return { text: serialize(jobs.map((j) => (j.name === name ? { ...j, enabled } : j))) };
}

/** Bridges: what each needs, and the command that starts them. The app cannot run a server for you; this is the exact setup to copy. */
export const BRIDGES = [
  { id: "slack", label: "Slack slash command", env: ["FORGE_SLACK_SIGNING_SECRET"], note: "Point the slash command's Request URL at https://<your tunnel>/slack." },
  { id: "discord", label: "Discord slash command", env: ["FORGE_DISCORD_PUBLIC_KEY"], note: "Set the Interactions Endpoint URL to https://<your tunnel>/discord." },
  { id: "linear", label: "Linear comments", env: ["FORGE_LINEAR_WEBHOOK_SECRET", "FORGE_LINEAR_API_KEY"], note: "Webhook URL https://<your tunnel>/linear for Comment events; a comment containing @forge is answered." },
  { id: "telegram", label: "Telegram bot", env: ["FORGE_TELEGRAM_TOKEN", "FORGE_TELEGRAM_CHATS"], note: "Only the chat ids you list are answered. No tunnel needed (long polling)." },
] as const;

/** A copy-and-run setup for the chosen bridges. Secrets are placeholders: this never holds or shows a real one. */
export function bridgeCommand(ids: string[], shell: "powershell" | "bash", provider = "ollama", model = ""): string {
  const chosen = BRIDGES.filter((b) => ids.includes(b.id));
  const vars = ["FORGE_SERVE_TOKEN", ...chosen.flatMap((b) => b.env)];
  const setVar = (v: string) => (shell === "powershell" ? `$env:${v} = "<paste ${v}>"` : `export ${v}="<paste ${v}>"`);
  const m = model ? ` --model ${model}` : "";
  return [...vars.map(setVar), `forge-code serve --provider ${provider}${m}`].join("\n");
}
