import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedGateway } from "@forge/model-gateway";
import type { StreamEvent } from "@forge/protocol";
import { jobArguments, parseSchedule, runSchedule, type ScheduleIo } from "../src/schedule";

const done: StreamEvent = { type: "done", usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.1 } };
const text = (t: string): StreamEvent => ({ type: "text", delta: t });
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent => ({ type: "tool_call", call: { id, name, args } });
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

function repo(schedule: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "forge-sched-")).replace(/[\\]/g, "/");
  writeFileSync(`${dir}/a.js`, "export const a = 1;\nexport const b = 2;\n");
  mkdirSync(`${dir}/.forge`, { recursive: true });
  writeFileSync(`${dir}/.forge/schedule.json`, typeof schedule === "string" ? schedule : JSON.stringify(schedule));
  return dir;
}
function harness(dir: string, gateway: ScriptedGateway | undefined, extra: Partial<ScheduleIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: ScheduleIo = { out: (t) => out.push(t), err: (t) => err.push(t), env: {}, cwd: dir, gateway, ...extra };
  return { io, out: () => out.join(""), err: () => err.join("") };
}
const runs = (dir: string) => {
  try {
    return readdirSync(`${dir}/.forge/schedule/runs`).sort();
  } catch {
    return [];
  }
};
const record = (dir: string, file: string) => JSON.parse(readFileSync(`${dir}/.forge/schedule/runs/${file}`, "utf8"));

describe("parseSchedule", () => {
  it("reads jobs and fills in the defaults: ask, no applying, nothing allowed", () => {
    const { jobs, errors } = parseSchedule(JSON.stringify({ jobs: [{ name: "review", cron: "0 2 * * *", prompt: "  Review the commits  " }] }));
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: "review", command: "ask", prompt: "Review the commits", apply: false, allow: [] });
    expect(jobs[0]!.cron.source).toBe("0 2 * * *");
  });

  it("leaves out a disabled job, and a job that is unusable with a reason, rather than running it half-configured", () => {
    const { jobs, errors } = parseSchedule(
      JSON.stringify({
        jobs: [
          { name: "off", cron: "* * * * *", prompt: "x", enabled: false },
          { name: "ok", cron: "* * * * *", prompt: "x" },
          { name: "no-prompt", cron: "* * * * *" },
          { name: "bad cron", cron: "* * *", prompt: "x" },
          { name: "bad-cron", cron: "61 * * * *", prompt: "x" },
          { name: "ask-apply", cron: "* * * * *", prompt: "x", apply: true },
          { name: "ask-allow", cron: "* * * * *", prompt: "x", allow: ["npm test"] },
          { name: "bad-command", cron: "* * * * *", prompt: "x", command: "fly" },
          { name: "bad-cost", cron: "* * * * *", prompt: "x", maxCost: -1 },
          { name: "ok", cron: "* * * * *", prompt: "again" },
          { cron: "* * * * *", prompt: "nameless" },
        ],
      }),
    );
    expect(jobs.map((j) => j.name)).toEqual(["ok"]);
    expect(errors).toHaveLength(9);
    expect(errors.join("\n")).toContain('job "no-prompt": needs a "prompt"');
    expect(errors.join("\n")).toContain("needs a name");
    expect(errors.join("\n")).toContain('job "bad-cron": minute: "61"');
    expect(errors.join("\n")).toContain('"apply" only makes sense with "command": "run"');
    expect(errors.join("\n")).toContain('"allow" only makes sense');
    expect(errors.join("\n")).toContain('"command" must be "ask" or "run"');
    expect(errors.join("\n")).toContain('"maxCost" must be a positive number');
    expect(errors.join("\n")).toContain("the name is used twice");
  });

  it("copes with a missing file, text that is not JSON, and the wrong shape", () => {
    expect(parseSchedule(null)).toEqual({ jobs: [], errors: [] });
    expect(parseSchedule("{not json").errors[0]).toContain("not valid JSON");
    expect(parseSchedule("[]").errors[0]).toContain('"jobs" list');
    expect(parseSchedule('{"jobs": 3}').errors[0]).toContain('"jobs" list');
  });
});

describe("jobArguments", () => {
  it("builds what you would type, and a prompt that starts with a dash is not read as an option", () => {
    const [job] = parseSchedule(JSON.stringify({ jobs: [{ name: "j", cron: "* * * * *", command: "run", prompt: "- fix the typo", apply: true, allow: ["npm test"], maxCost: 0.5, maxSteps: 4, model: "m", provider: "openai", baseUrl: "http://x" }] })).jobs;
    expect(jobArguments(job!)).toEqual(["run", " - fix the typo", "--json", "--apply", "--allow", "npm test", "--max-cost", "0.5", "--max-steps", "4", "--model", "m", "--provider", "openai", "--base-url", "http://x"]);
  });
});

describe("schedule list", () => {
  it("shows each job with when it next runs", async () => {
    const dir = repo({ jobs: [{ name: "nightly", cron: "0 2 * * *", prompt: "review" }, { name: "weekly", cron: "0 9 * * mon", command: "run", prompt: "deps", apply: true }] });
    const t = harness(dir, undefined, { now: () => at(2026, 3, 4, 10, 0) }); // a Wednesday
    expect(await runSchedule(["list"], t.io)).toBe(0);
    expect(t.out()).toContain("nightly");
    expect(t.out()).toContain("next: 2026-03-05 02:00");
    expect(t.out()).toContain("next: 2026-03-09 09:00"); // the next Monday
    expect(t.out()).toContain("(applies changes)");
  });

  it("reports a missing schedule, and exits 1 when some jobs are unusable (while still listing the good ones)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "forge-sched-")).replace(/[\\]/g, "/");
    const none = harness(empty, undefined);
    expect(await runSchedule(["list"], none.io)).toBe(1);
    expect(none.err()).toContain("no schedule at .forge/schedule.json");

    const dir = repo({ jobs: [{ name: "good", cron: "@daily", prompt: "x" }, { name: "bad", cron: "nonsense", prompt: "x" }] });
    const t = harness(dir, undefined, { now: () => at(2026, 3, 4) });
    expect(await runSchedule(["list"], t.io)).toBe(1);
    expect(t.out()).toContain("good");
    expect(t.err()).toContain('job "bad"');
  });
});

describe("schedule run-due", () => {
  it("runs the job that is due in that minute, saves the result, and leaves the others alone", async () => {
    const dir = repo({ jobs: [{ name: "nightly", cron: "0 2 * * *", prompt: "review the commits" }, { name: "noon", cron: "0 12 * * *", prompt: "noon task" }] });
    const gw = new ScriptedGateway([[text("Two commits, no problems found."), done]]);
    const t = harness(dir, gw);
    expect(await runSchedule(["run-due", "--at", "2026-03-04T02:00:00"], t.io)).toBe(0);
    expect(gw.requests).toHaveLength(1); // only "nightly" ran
    expect(gw.requests[0]!.messages.at(-1)!.content).toContain("review the commits");
    const files = runs(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^nightly-20260304-0200\.json$/);
    const r = record(dir, files[0]!);
    expect(r).toMatchObject({ job: "nightly", cron: "0 2 * * *", command: "ask", exitCode: 0 });
    expect(r.result.answer).toBe("Two commits, no problems found.");
    expect(t.out()).toContain("nightly: done");
    expect(t.out()).toContain("$0.10");
  });

  it("says when nothing is due, and runs nothing", async () => {
    const dir = repo({ jobs: [{ name: "nightly", cron: "0 2 * * *", prompt: "x" }] });
    const gw = new ScriptedGateway([]);
    const t = harness(dir, gw);
    expect(await runSchedule(["run-due", "--at", "2026-03-04T03:30:00"], t.io)).toBe(0);
    expect(t.out()).toContain("Nothing is due.");
    expect(gw.requests).toHaveLength(0);
    expect(runs(dir)).toEqual([]);
  });

  it("a job that edits only PROPOSES by default (the diff is saved, the file is untouched), and writes only with apply", async () => {
    const edit = () => [call("1", "edit_file", { path: "a.js", old_string: "b = 2", new_string: "b = 20", reason: "bump b" }), done];
    const dir = repo({ jobs: [{ name: "bump", cron: "* * * * *", command: "run", prompt: "bump b" }] });
    const t = harness(dir, new ScriptedGateway([edit(), [text("Done."), done]]));
    expect(await runSchedule(["run-due", "--at", "2026-03-04T02:00:00"], t.io)).toBe(0);
    expect(readFileSync(`${dir}/a.js`, "utf8")).toContain("b = 2;"); // untouched
    const r = record(dir, runs(dir)[0]!);
    expect(r.result.applied).toBe(false);
    expect(r.result.files[0].path).toBe("a.js");
    expect(r.result.files[0].diff).toContain("+export const b = 20;");
    expect(t.out()).toContain("1 file proposed");

    const dir2 = repo({ jobs: [{ name: "bump", cron: "* * * * *", command: "run", prompt: "bump b", apply: true }] });
    const t2 = harness(dir2, new ScriptedGateway([edit(), [text("Done."), done]]));
    expect(await runSchedule(["run-due", "--at", "2026-03-04T02:00:00"], t2.io)).toBe(0);
    expect(readFileSync(`${dir2}/a.js`, "utf8")).toContain("b = 20;");
    expect(t2.out()).toContain("1 file written");
  });

  it("exits 1 when a job fails (the failure is recorded), and 2 when one stops at a limit", async () => {
    const dir = repo({ jobs: [{ name: "broken", cron: "* * * * *", prompt: "x", model: "m" }] });
    const failing = new ScriptedGateway([]);
    failing.stream = () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("the model server is down")) }) });
    const t = harness(dir, failing);
    expect(await runSchedule(["run-due", "--at", "2026-03-04T02:00:00"], t.io)).toBe(1);
    const r = record(dir, runs(dir)[0]!);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("the model server is down");
    expect(t.out()).toContain("broken: failed");

    const dir2 = repo({ jobs: [{ name: "long", cron: "* * * * *", prompt: "x", maxSteps: 1 }] });
    const looping = new ScriptedGateway([[call("1", "read_file", { path: "a.js" }), done], [call("2", "read_file", { path: "a.js" }), done]]);
    const t2 = harness(dir2, looping);
    expect(await runSchedule(["run-due", "--at", "2026-03-04T02:00:00"], t2.io)).toBe(2);
    expect(t2.out()).toContain("stopped at the steps limit");
  });

  it("rejects a bad --at, and an unknown command or option", async () => {
    const dir = repo({ jobs: [] });
    expect(await runSchedule(["run-due", "--at", "yesterday-ish"], harness(dir, undefined).io)).toBe(1);
    const t = harness(dir, undefined);
    expect(await runSchedule(["fly"], t.io)).toBe(1);
    expect(t.err()).toContain('unknown schedule command "fly"');
    expect(await runSchedule(["run-due", "--nope"], harness(dir, undefined).io)).toBe(1);
    expect(await runSchedule(["run-due", "somejob"], harness(dir, undefined).io)).toBe(1);
  });
});

describe("schedule run", () => {
  it("runs one named job right now, whatever its schedule, and refuses an unknown name", async () => {
    const dir = repo({ jobs: [{ name: "weekly", cron: "0 9 * * mon", prompt: "weekly task" }] });
    const gw = new ScriptedGateway([[text("ok"), done]]);
    const t = harness(dir, gw, { now: () => at(2026, 3, 4, 15, 21) }); // a Wednesday afternoon: not due
    expect(await runSchedule(["run", "weekly"], t.io)).toBe(0);
    expect(gw.requests).toHaveLength(1);
    expect(runs(dir)[0]).toMatch(/^weekly-20260304-1521\.json$/);
    const missing = harness(dir, undefined);
    expect(await runSchedule(["run", "nope"], missing.io)).toBe(1);
    expect(missing.err()).toContain('no usable job named "nope". Jobs: weekly');
    expect(await runSchedule(["run"], harness(dir, undefined).io)).toBe(1);
  });
});

describe("schedule watch", () => {
  it("runs each job in the minute it is due, once, however often it wakes within that minute", async () => {
    const dir = repo({ jobs: [{ name: "every-minute", cron: "* * * * *", prompt: "tick" }, { name: "on-the-half", cron: "30 * * * *", prompt: "half" }] });
    const gw = new ScriptedGateway(Array.from({ length: 6 }, () => [text("ok"), done]));
    let clock = at(2026, 3, 4, 10, 29).getTime() + 5_000; // 10:29:05
    const slept: number[] = [];
    const t = harness(dir, gw, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept.push(ms);
        clock += 20_000; // wake every 20 seconds, so each minute is seen about three times
      },
    });
    expect(await runSchedule(["watch", "--ticks", "3"], t.io)).toBe(0); // the minutes 10:29, 10:30 and 10:31
    const files = runs(dir);
    expect(files.filter((f) => f.startsWith("every-minute-"))).toHaveLength(3); // once per minute, not once per wake-up
    expect(files.filter((f) => f.startsWith("on-the-half-"))).toHaveLength(1); // only in 10:30
    expect(files.find((f) => f.startsWith("on-the-half-"))).toMatch(/-20260304-1030\.json$/);
    expect(gw.requests).toHaveLength(4);
    expect(t.out()).toContain("Watching 2 jobs.");
    expect(slept.every((ms) => ms >= 1000)).toBe(true);
  });
});
