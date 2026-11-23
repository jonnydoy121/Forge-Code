import { describe, expect, it } from "vitest";
import { BRIDGES, bridgeCommand, describeJobs, readRaw, removeJob, saveJob, setEnabled, validateJob } from "./scheduleEdit";

const job = { name: "nightly", cron: "0 2 * * *", prompt: "review the commits", command: "ask" };
const at = (y: number, mo: number, d: number, h = 0) => new Date(y, mo - 1, d, h, 0, 0, 0);
const file = (jobs: unknown[]) => JSON.stringify({ jobs });

describe("schedule editing", () => {
  it("adds a valid job to a missing file, keeping the file well-formed", () => {
    const r = saveJob(null, job);
    expect("text" in r && JSON.parse(r.text)).toEqual({ jobs: [job] });
  });

  it("refuses an invalid job and explains why, without producing new text", () => {
    expect(saveJob(null, { ...job, cron: "61 * * * *" })).toMatchObject({ error: expect.stringContaining("minute") });
    expect(saveJob(null, { ...job, prompt: "" })).toMatchObject({ error: expect.stringContaining("prompt") });
    expect(saveJob(null, { ...job, apply: true })).toMatchObject({ error: expect.stringContaining("apply") });
    expect(saveJob(file([job]), { ...job, prompt: "other" })).toMatchObject({ error: expect.stringContaining("already a job") });
  });

  it("changes a job in place and keeps fields the screen does not show, and other jobs", () => {
    const text = file([{ ...job, allow: ["npm test"], maxCost: 1 }, { name: "weekly", cron: "@weekly", prompt: "deps" }]);
    const r = saveJob(text, { ...job, prompt: "review carefully" }, "nightly");
    const jobs = "text" in r ? JSON.parse(r.text).jobs : [];
    expect(jobs[0]).toMatchObject({ name: "nightly", prompt: "review carefully", allow: ["npm test"], maxCost: 1 });
    expect(jobs).toHaveLength(2);
  });

  it("removes a job, and disables and re-enables one without losing it", () => {
    const text = file([job, { name: "weekly", cron: "@weekly", prompt: "deps" }]);
    expect(JSON.parse((removeJob(text, "nightly") as { text: string }).text).jobs.map((j: { name: string }) => j.name)).toEqual(["weekly"]);
    const off = (setEnabled(text, "nightly", false) as { text: string }).text;
    expect(JSON.parse(off).jobs[0].enabled).toBe(false);
    expect(JSON.parse((setEnabled(off, "nightly", true) as { text: string }).text).jobs[0].enabled).toBe(true);
  });

  it("will not edit a file that is not valid JSON", () => {
    expect(readRaw("{nope").error).toContain("not valid JSON");
    expect(saveJob("{nope", job)).toMatchObject({ error: expect.stringContaining("not valid JSON") });
    expect(removeJob('{"jobs": 3}', "x")).toMatchObject({ error: expect.stringContaining("jobs") });
  });

  it("describes each job: next run, disabled, and what is wrong with a broken one", () => {
    const text = file([job, { name: "off", cron: "@daily", prompt: "x", enabled: false }, { name: "bad", cron: "nonsense", prompt: "x" }, { ...job }]);
    const { views } = describeJobs(text, at(2026, 3, 4, 10));
    expect(views[0]!.next).toEqual(at(2026, 3, 5, 2));
    expect(views[1]).toMatchObject({ enabled: false, next: null, problem: null });
    expect(views[2]!.problem).toContain("five fields");
    expect(views[3]!.problem).toContain("used twice");
    expect(validateJob({ ...job, command: "fly" })).toContain('"command" must be');
  });
});

describe("bridge setup", () => {
  it("builds the commands with placeholders only, for the chosen bridges and shell", () => {
    const ps = bridgeCommand(["slack", "linear"], "powershell", "strata", "swift-iq2_xs");
    expect(ps).toContain('$env:FORGE_SERVE_TOKEN = "<paste FORGE_SERVE_TOKEN>"');
    expect(ps).toContain("FORGE_SLACK_SIGNING_SECRET");
    expect(ps).toContain("FORGE_LINEAR_WEBHOOK_SECRET");
    expect(ps).not.toContain("FORGE_TELEGRAM_TOKEN");
    expect(ps.endsWith("forge-code serve --provider strata --model swift-iq2_xs")).toBe(true);
    const sh = bridgeCommand(["telegram"], "bash");
    expect(sh).toContain('export FORGE_TELEGRAM_CHATS="<paste FORGE_TELEGRAM_CHATS>"');
    expect(sh.endsWith("forge-code serve --provider ollama")).toBe(true);
  });

  it("lists the four bridges with the variables each needs", () => {
    expect(BRIDGES.map((b) => b.id)).toEqual(["slack", "discord", "linear", "telegram"]);
    expect(BRIDGES.find((b) => b.id === "linear")!.env).toEqual(["FORGE_LINEAR_WEBHOOK_SECRET", "FORGE_LINEAR_API_KEY"]);
  });
});
