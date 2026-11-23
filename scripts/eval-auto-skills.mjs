// Live experiment (opt-in; needs Ollama with the model pulled and `npm run build:cli`): do automatically applied skills make a local
// model follow house conventions it cannot guess? Run: EVAL_REPEATS=5 node scripts/eval-auto-skills.mjs
// Conditions: none (no skills exist), index (skills listed, the model must call use_skill itself), auto (matching skills applied up front).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.EVAL_CLI ?? join(here, "..", "target", "cli", "forge-code.cjs");
const MODEL = process.env.EVAL_MODEL ?? "qwen2.5-coder:7b";
const REPEATS = Number(process.env.EVAL_REPEATS ?? 1);

const SKILLS = {
  "add-unit-tests": {
    description: "Write or fix unit tests with vitest: test files, mocks, fixtures and coverage",
    body: "House rule for tests: put test files in a `__spec__` folder next to the source file and name them `<module>.spec.ts` (never `.test.ts`). Every test name must start with the word `should`.",
  },
  "git-commit-style": {
    description: "Write commit messages and pull request descriptions in the team convention",
    body: "House rule for commits: the subject is `<type>(<scope>): <subject>` where type is one of feat, fix, chore. The message must END with a line `Refs: FRG-<ticket number>`.",
  },
  "api-endpoint": {
    description: "Add or change REST API endpoints: routes, request validation, error responses and OpenAPI docs",
    body: "House rule for APIs: every error response is JSON with exactly three fields: `code` (a string), `message` (a string) and `requestId` (a string copied from the `x-request-id` header).",
  },
  "release-checklist": {
    description: "Prepare a release: bump the version, update the changelog, tag and publish",
    body: "House rule for releases: write the notes to `RELEASES/<version>.md` and tag the commit `rel-<version>`. Never use the `v<version>` tag form.",
  },
};

const TASKS = [
  { skill: "add-unit-tests", prompt: "Write unit tests with vitest for a function slugify(title) in src/slug.ts. Show the file path and the test code.", check: (a) => /__spec__/.test(a) && /\.spec\.ts/.test(a) },
  { skill: "add-unit-tests", prompt: "Add unit tests and mocks for the parseDuration function in src/time.ts. Give the file path and the code.", check: (a) => /__spec__/.test(a) && /\.spec\.ts/.test(a) },
  { skill: "add-unit-tests", prompt: "I need test coverage with fixtures for the invoice totals calculator in src/invoice.ts. Give the test file path and code.", check: (a) => /__spec__/.test(a) && /\.spec\.ts/.test(a) },
  { skill: "git-commit-style", prompt: "Write the commit message and pull request description for adding retry logic to the HTTP client.", check: (a) => /Refs: FRG-/.test(a) },
  { skill: "git-commit-style", prompt: "Write a commit message and pull request description for fixing the off-by-one error in pagination.", check: (a) => /Refs: FRG-/.test(a) },
  { skill: "git-commit-style", prompt: "Draft the pull request description and commit message for upgrading the logging library.", check: (a) => /Refs: FRG-/.test(a) },
  { skill: "api-endpoint", prompt: "Add a REST endpoint GET /users/:id with request validation and error responses, in Express. Show the code.", check: (a) => /requestId/.test(a) && /x-request-id/i.test(a) },
  { skill: "api-endpoint", prompt: "Write the API route DELETE /orders/:id with request validation and its error responses. Show the code.", check: (a) => /requestId/.test(a) && /x-request-id/i.test(a) },
  { skill: "api-endpoint", prompt: "Create a REST endpoint POST /comments with request validation and error responses. Show the code.", check: (a) => /requestId/.test(a) && /x-request-id/i.test(a) },
  { skill: "release-checklist", prompt: "Prepare release 1.8.0: bump the version, update the changelog, tag and publish. List the exact steps and commands.", check: (a) => /rel-1\.8\.0/.test(a) && !/\bv1\.8\.0\b/.test(a.replace(/RELEASES\/1\.8\.0/g, "")) },
  { skill: "release-checklist", prompt: "We need to publish a release 2.0.1 with a version bump, changelog and tag. List the exact steps and commands.", check: (a) => /rel-2\.0\.1/.test(a) },
  { skill: "release-checklist", prompt: "Prepare release 0.9.3: bump version, update the changelog, tag and publish. Give the commands.", check: (a) => /rel-0\.9\.3/.test(a) },
];
const CONTROLS = ["Explain what a closure is in JavaScript, in two sentences.", "What does the HTTP status code 404 mean?", "Rename the variable foo to count in this line: const foo = 3;"];

function project(withSkills) {
  const dir = mkdtempSync(join(tmpdir(), "forge-skilleval-")).replace(/\\/g, "/");
  writeFileSync(`${dir}/README.md`, "demo project\n");
  if (withSkills) {
    for (const [name, s] of Object.entries(SKILLS)) {
      mkdirSync(`${dir}/.forge/skills/${name}`, { recursive: true });
      writeFileSync(`${dir}/.forge/skills/${name}/SKILL.md`, `---\ndescription: ${s.description}\n---\n${s.body}\n`);
    }
  }
  return dir;
}

function run(dir, prompt, extra = []) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, "ask", prompt, "--provider", "ollama", "--model", MODEL, "--max-steps", "6", ...extra], { cwd: dir, encoding: "utf8", timeout: 240_000, env: { ...process.env } });
  return { answer: r.stdout ?? "", err: r.stderr ?? "", code: r.status, secs: (Date.now() - t0) / 1000 };
}

const conditions = [
  { name: "none", withSkills: false, extra: [] },
  { name: "index", withSkills: true, extra: ["--no-auto-skills"] },
  { name: "auto", withSkills: true, extra: [] },
];
const results = [];
for (let rep = 0; rep < REPEATS; rep++) {
  for (const t of TASKS) {
    for (const c of conditions) {
      const dir = project(c.withSkills);
      const r = run(dir, t.prompt, c.extra);
      const row = { rep, skill: t.skill, condition: c.name, pass: t.check(r.answer), usedSkillTool: /use_skill/.test(r.err), autoApplied: /applying skill/.test(r.err), secs: r.secs, code: r.code, prompt: t.prompt.slice(0, 50) };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
// controls: skills must not be injected for unrelated questions
const ctl = [];
for (const prompt of CONTROLS) {
  const dir = project(true);
  const r = run(dir, prompt);
  ctl.push({ prompt: prompt.slice(0, 40), autoApplied: /applying skill/.test(r.err) });
}
console.log("CONTROLS " + JSON.stringify(ctl));
const summary = {};
for (const c of conditions) {
  const rows = results.filter((r) => r.condition === c.name);
  summary[c.name] = { pass: rows.filter((r) => r.pass).length, of: rows.length, usedSkillTool: rows.filter((r) => r.usedSkillTool).length, autoApplied: rows.filter((r) => r.autoApplied).length, meanSecs: +(rows.reduce((s, r) => s + r.secs, 0) / rows.length).toFixed(1) };
}
console.log("SUMMARY " + JSON.stringify(summary));
mkdirSync(join(here, "..", "target"), { recursive: true });
writeFileSync(join(here, "..", "target", `skill-eval-${process.env.EVAL_TAG ?? "latest"}.json`), JSON.stringify({ model: MODEL, results, ctl, summary }, null, 2));
