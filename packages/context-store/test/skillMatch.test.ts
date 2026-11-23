import { describe, expect, it } from "vitest";
import { matchSkills, renderMatchedSkills, words, type Skill } from "../src";

const skill = (name: string, description: string, body = `Instructions for ${name}.`): Skill => ({ name, description, body, source: "project", dir: `/r/.forge/skills/${name}`, scripts: [], files: [], declared: {}, problems: [] });

const SKILLS: Skill[] = [
  skill("add-unit-tests", "Write or fix unit tests with vitest: test files, mocks, fixtures and coverage"),
  skill("database-migration", "Create and review database schema migrations: SQL, rollback and backfill steps"),
  skill("release-checklist", "Prepare a release: bump the version, update the changelog, tag and publish"),
  skill("api-endpoint", "Add or change REST API endpoints: routes, request validation, error responses and OpenAPI docs"),
  skill("react-component", "Build React components with Tailwind: props, accessibility, state and storybook stories"),
  skill("security-review", "Review code for security problems: injection, authentication, secrets and unsafe input handling"),
  skill("performance-profiling", "Profile and speed up slow code: benchmarks, hot paths, memory and caching"),
  skill("git-commit-style", "Write commit messages and pull request descriptions in the team convention"),
];

// Hand-labelled by the author, who also wrote the skills: expect the result to flatter the matcher. The negatives are the point:
// each contains a word that looks relevant but is not about the skill ("contest", "release the lock", "migrating to Vue").
const TASKS: { task: string; expect: string[] }[] = [
  { task: "Write unit tests for the parser and mock the filesystem", expect: ["add-unit-tests"] },
  { task: "the vitest suite is failing after my change, please fix the tests", expect: ["add-unit-tests"] },
  { task: "increase test coverage on the checkout module", expect: ["add-unit-tests"] },
  { task: "Add a migration that adds a nullable email column to users, with a rollback", expect: ["database-migration"] },
  { task: "review this SQL schema migration for the orders table", expect: ["database-migration"] },
  { task: "I need to backfill the new column safely", expect: ["database-migration"] },
  { task: "Prepare release 2.4.0: bump the version and update the changelog", expect: ["release-checklist"] },
  { task: "we need to publish a new version and tag it", expect: ["release-checklist"] },
  { task: "Add a REST endpoint GET /orders/:id with request validation", expect: ["api-endpoint"] },
  { task: "the API route returns a 500 instead of a proper error response", expect: ["api-endpoint"] },
  { task: "update the OpenAPI docs for the payments routes", expect: ["api-endpoint"] },
  { task: "Build a React component for the pricing card with Tailwind", expect: ["react-component"] },
  { task: "make the dropdown component accessible and add a storybook story", expect: ["react-component"] },
  { task: "Review this handler for injection problems and unsafe input handling", expect: ["security-review"] },
  { task: "audit the authentication code for security issues and leaked secrets", expect: ["security-review"] },
  { task: "The search page is slow, profile it and find the hot path", expect: ["performance-profiling"] },
  { task: "write a benchmark and reduce memory use in the importer", expect: ["performance-profiling"] },
  { task: "Write the commit message and pull request description for these changes", expect: ["git-commit-style"] },
  // two skills
  { task: "Add an API endpoint for exports and write tests for it", expect: ["api-endpoint", "add-unit-tests"] },
  { task: "review the new login route for security problems and add coverage for it", expect: ["security-review", "add-unit-tests"] },
  // nothing applies
  { task: "Rename the variable foo to count in utils.ts", expect: [] },
  { task: "explain how the indexer works", expect: [] },
  { task: "what does this regex do?", expect: [] },
  { task: "fix the typo in the README", expect: [] },
  { task: "Convert this callback to async/await", expect: [] },
  // near misses: look relevant, are not
  { task: "enter the coding contest with a faster sorting algorithm", expect: [] },
  { task: "release the lock before returning from the function", expect: [] },
  { task: "we are migrating the frontend from Angular to Vue", expect: [] },
  { task: "add a new field to the user interface settings screen", expect: [] },
  { task: "the team convention is to use tabs, please fix the indentation", expect: [] },
  { task: "memory leak? no, I just want to know what the cache key format is", expect: [] },
  { task: "cover the sofa with a blanket", expect: [] },
  { task: "How do I publish a package to npm?", expect: [] },
  { task: "tag every function with a doc comment", expect: [] },
  { task: "write a function that checks the version string is valid semver", expect: [] },
  { task: "add authentication to the websocket", expect: [] },
];

describe("matchSkills", () => {
  it("measures how well tasks are matched to skills (see the printed numbers)", () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let exact = 0;
    const misses: string[] = [];
    for (const t of TASKS) {
      const got = matchSkills(t.task, SKILLS).map((m) => m.skill.name);
      const want = new Set(t.expect);
      for (const g of got) {
        if (want.has(g)) tp++;
        else {
          fp++;
          misses.push(`FALSE POSITIVE ${g}: ${t.task}`);
        }
      }
      for (const w of want) {
        if (!got.includes(w)) {
          fn++;
          misses.push(`MISSED ${w}: ${t.task}`);
        }
      }
      if (got.length === want.size && got.every((g) => want.has(g))) exact++;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    console.log(`skill matching over ${TASKS.length} tasks: precision ${(precision * 100).toFixed(0)}%, recall ${(recall * 100).toFixed(0)}%, exactly right ${exact}/${TASKS.length}\n${misses.join("\n")}`);
    // Regression guards set just below the measured numbers (precision 95%, recall 91%): a loaded skill should almost always be the right one.
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });

  it("does not apply a skill on one stray word, and applies nothing for an empty task or no skills", () => {
    expect(matchSkills("contest", SKILLS)).toEqual([]);
    expect(matchSkills("", SKILLS)).toEqual([]);
    expect(matchSkills("write unit tests", [])).toEqual([]);
  });

  it("applies at most two skills by default, best first, and explains the match", () => {
    const m = matchSkills("add a REST endpoint with request validation, write tests with mocks for it and review it for security and injection", SKILLS);
    expect(m.length).toBeLessThanOrEqual(2);
    expect(m[0]!.score).toBeGreaterThanOrEqual(m[1]?.score ?? 0);
    expect(m[0]!.matched.length).toBeGreaterThan(1);
    expect(matchSkills("add a REST endpoint with request validation, write tests with mocks and review for security and injection", SKILLS, { max: 3 }).length).toBeGreaterThan(2);
  });

  it("stems plurals and tenses, and ignores filler words", () => {
    expect(words("Testing the tests that tested everything")).toEqual(["test", "test", "test", "everyth"]);
    expect(words("the and of")).toEqual([]);
  });

  it("renders the instructions with the reason, and shortens a very long skill", () => {
    const long = skill("big", "Handle the giant widget frobnicator", "x".repeat(9000));
    const text = renderMatchedSkills(matchSkills("fix the giant widget frobnicator", [long]));
    expect(text).toContain('House rules from "big" (they apply because the request mentions');
    expect(text.length).toBeLessThan(4400);
    expect(text).toContain("use_skill");
  });
});
