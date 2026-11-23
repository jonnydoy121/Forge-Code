// Scheduled agent runs: `.forge/schedule.json` lists jobs with a cron expression; `forge-code schedule` runs the ones that are due.
//
//   {"jobs": [{"name": "nightly-review", "cron": "0 2 * * *", "command": "ask", "prompt": "Review yesterday's commits for bugs"},
//             {"name": "weekly-deps",    "cron": "0 9 * * mon", "command": "run", "prompt": "Update patch versions and run the tests",
//              "allow": ["npm test"], "maxCost": 1}]}
//
//   forge-code schedule list                 the jobs and when each next runs
//   forge-code schedule run-due              run the jobs due this minute (for the OS scheduler, Task Scheduler or a CI `schedule:` trigger)
//   forge-code schedule run <name>           run one job now
//   forge-code schedule watch                stay running and run jobs as they come due
//
// A job that edits (`"command": "run"`) only proposes: its diffs are saved with the result. It writes files only with `"apply": true`.
// Every run is recorded in `.forge/schedule/runs/`. Times are the machine's local time.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cronMatches, nextRun, parseSchedule, type Job } from "@forge/context-store";
import { runCli, type Io } from "./cli";

export { parseSchedule, type Job } from "@forge/context-store";

export interface ScheduleIo extends Io {
  /** The current time (tests supply their own clock). */
  now?: () => Date;
  /** Wait this many milliseconds (tests do not really wait). */
  sleep?: (ms: number) => Promise<void>;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const clock = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Argument vector for one job: the same thing you would type for `forge-code ask|run`. A leading space keeps a prompt that begins with "-" from being read as an option. */
export function jobArguments(job: Job): string[] {
  return [
    job.command,
    ` ${job.prompt}`,
    "--json",
    ...(job.apply ? ["--apply"] : []),
    ...job.allow.flatMap((a) => ["--allow", a]),
    ...(job.maxCost ? ["--max-cost", String(job.maxCost)] : []),
    ...(job.maxSteps ? ["--max-steps", String(job.maxSteps)] : []),
    ...(job.model ? ["--model", job.model] : []),
    ...(job.provider ? ["--provider", job.provider] : []),
    ...(job.baseUrl ? ["--base-url", job.baseUrl] : []),
  ];
}

async function runJob(job: Job, io: ScheduleIo, root: string, at: Date): Promise<number> {
  const out: string[] = [];
  const err: string[] = [];
  const startedAt = new Date();
  let code: number;
  try {
    code = await runCli(jobArguments(job), { ...io, out: (t) => out.push(t), err: (t) => err.push(t) });
  } catch (e) {
    code = 1;
    err.push(e instanceof Error ? e.message : String(e));
  }
  let result: unknown = null;
  try {
    result = JSON.parse(out.join(""));
  } catch {
    /* no machine-readable result (the run failed before it could print one) */
  }
  const dir = `${root}/.forge/schedule/runs`;
  const file = `${dir}/${job.name}-${stamp(at)}.json`;
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ job: job.name, cron: job.cron.source, command: job.command, scheduledFor: at.toISOString(), startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), exitCode: code, result, stderr: err.join("").slice(-2000) }, null, 2), "utf8");
  const r = result as { files?: unknown[]; costUsd?: number; stopped?: string | null } | null;
  const files = r?.files?.length ?? 0;
  io.out(`[${clock(at)}] ${job.name}: ${code === 0 ? "done" : code === 2 ? `stopped at the ${r?.stopped ?? "a"} limit` : "failed"}${job.command === "run" ? `, ${files} file${files === 1 ? "" : "s"} ${job.apply ? "written" : "proposed"}` : ""}${typeof r?.costUsd === "number" ? `, $${r.costUsd.toFixed(2)}` : ""} -> ${file}\n`);
  return code;
}

export const SCHEDULE_USAGE = `forge-code schedule: run the agent on a schedule

Usage:
  forge-code schedule list                 the jobs in .forge/schedule.json and when each next runs
  forge-code schedule run-due              run the jobs due this minute (call it every minute from cron, Task Scheduler or CI)
  forge-code schedule run <name>           run one job now
  forge-code schedule watch                stay running and run jobs as they come due

Options:
  --file <path>     the schedule file (default .forge/schedule.json)
  --at <time>       treat this as the current time (an ISO date and time), for run-due
  --window <n>      run-due: a job is due if it matched at any time in the last n minutes (default 1). Use it when the
                    trigger is late or coarse, such as a CI schedule that fires every 15 minutes: --window 15
  --ticks <n>       watch: stop after n minutes (default: run until stopped)

Each job: {"name", "cron", "prompt", "command": "ask" | "run", "apply": false, "allow": [], "maxCost", "maxSteps", "model", "provider", "baseUrl", "enabled"}.
A "run" job only proposes changes (saved with its result) unless it says "apply": true. Results are saved in .forge/schedule/runs/.
The model, provider and key come from the same FORGE_* variables as the other commands. Times are local.
`;

export async function runSchedule(args: string[], io: ScheduleIo): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help") return io.out(SCHEDULE_USAGE), sub ? 0 : 1;
  if (!["list", "run-due", "run", "watch"].includes(sub)) return io.err(`forge-code: unknown schedule command "${sub}"\n\n${SCHEDULE_USAGE}`), 1;

  let file = ".forge/schedule.json";
  let at: Date | null = null;
  let ticks = Infinity;
  let window = 1;
  const names: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "--file") file = value();
      else if (a === "--at") {
        at = new Date(value());
        if (Number.isNaN(at.getTime())) return io.err("forge-code: --at needs a date and time such as 2026-03-04T02:00\n"), 1;
      } else if (a === "--window") {
        window = Math.floor(Number(value()));
        if (!(window >= 1 && window <= 1440)) return io.err("forge-code: --window must be a whole number of minutes from 1 to 1440\n"), 1;
      } else if (a === "--ticks") {
        ticks = Math.floor(Number(value()));
        if (!(ticks >= 1)) return io.err("forge-code: --ticks must be a whole number of at least 1\n"), 1;
      } else if (a.startsWith("-")) return io.err(`forge-code: unknown option ${a}\n`), 1;
      else names.push(a);
    } catch (e) {
      return io.err(`forge-code: ${(e as Error).message}\n`), 1;
    }
  }

  const root = resolve(io.cwd).replace(/[\\]/g, "/");
  const path = resolve(root, file);
  let text: string | null = null;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return io.err(`forge-code: cannot read ${file}: ${(e as Error).message}\n`), 1;
  }
  if (text === null) return io.err(`forge-code: no schedule at ${file}. Create it with a "jobs" list (see: forge-code schedule --help).\n`), 1;
  const { jobs, errors } = parseSchedule(text);
  for (const e of errors) io.err(`forge-code: ${file}: ${e}\n`);
  const now = () => io.now?.() ?? new Date();

  if (sub === "list") {
    if (jobs.length === 0) io.out("No usable jobs.\n");
    const t = now();
    for (const j of jobs) {
      const next = nextRun(j.cron, t);
      io.out(`${j.name.padEnd(24)} ${j.cron.source.padEnd(16)} ${j.command.padEnd(4)} next: ${next ? clock(next) : "never"}${j.apply ? "  (applies changes)" : ""}\n`);
    }
    return errors.length ? 1 : 0;
  }

  const worst = (codes: number[]) => (codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0);

  if (sub === "run") {
    if (names.length !== 1) return io.err('forge-code: "schedule run" needs exactly one job name\n'), 1;
    const job = jobs.find((j) => j.name === names[0]);
    if (!job) return io.err(`forge-code: no usable job named "${names[0]}". Jobs: ${jobs.map((j) => j.name).join(", ") || "(none)"}\n`), 1;
    return runJob(job, io, root, now());
  }

  if (names.length) return io.err(`forge-code: "schedule ${sub}" takes no job names\n`), 1;
  /** The latest minute in the last `back` minutes (ending at `when`) at which the job's schedule matched, or null. */
  const lastMatch = (j: Job, when: Date, back: number): Date | null => {
    const end = Math.floor(when.getTime() / 60_000) * 60_000;
    for (let i = 0; i < back; i++) {
      const m = new Date(end - i * 60_000);
      if (cronMatches(j.cron, m)) return m;
    }
    return null;
  };
  const runDue = async (when: Date, back = 1) => {
    const codes: number[] = [];
    for (const j of jobs) {
      const m = lastMatch(j, when, back);
      if (m) codes.push(await runJob(j, io, root, m));
    }
    return codes;
  };

  if (sub === "run-due") {
    const codes = await runDue(at ?? now(), window);
    if (codes.length === 0) io.out("Nothing is due.\n");
    return Math.max(worst(codes), errors.length ? 1 : 0);
  }

  // watch: once a minute, run what is due in that minute; a minute is never handled twice.
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  io.out(`Watching ${jobs.length} job${jobs.length === 1 ? "" : "s"}. Stop with Ctrl+C.\n`);
  const codes: number[] = [];
  let lastMinute = -1;
  for (let handled = 0; handled < ticks; ) {
    const t = now();
    const minute = Math.floor(t.getTime() / 60_000);
    if (minute !== lastMinute) {
      lastMinute = minute;
      handled++;
      codes.push(...(await runDue(t)));
    }
    if (handled >= ticks) break;
    await sleep(Math.max(1000, 60_000 - (now().getTime() % 60_000) + 50)); // to just after the next minute begins
  }
  return worst(codes);
}
