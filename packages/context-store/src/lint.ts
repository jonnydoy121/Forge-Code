import { containsSecret } from "@forge/protocol";
import type { ProjectCommands } from "@forge/verify";
import { renderCommandsSection } from "@forge/verify";
import type { ContextFs, StoredRule } from "./rules";

export interface ProjectFacts {
  deps: Set<string>;
  scripts: Record<string, string>;
  /** ESLint rule ids found enabled in the config text (best effort). */
  eslintEnforces: Set<string>;
  hasEslint: boolean;
  prettier: { semi?: boolean; useTabs?: boolean; singleQuote?: boolean; tabWidth?: number };
  editorconfigIndent?: "tab" | "space";
  strictTs: boolean;
  /** how many source files use default exports vs named exports (from the index) */
  defaultExportFiles: number;
  namedExportFiles: number;
  testNaming: { test: number; spec: number };
}

export interface LintWarning {
  ruleId: string;
  ruleName: string;
  message: string;
}

export const emptyFacts = (): ProjectFacts => ({
  deps: new Set(),
  scripts: {},
  eslintEnforces: new Set(),
  hasEslint: false,
  prettier: {},
  strictTs: false,
  defaultExportFiles: 0,
  namedExportFiles: 0,
  testNaming: { test: 0, spec: 0 },
});

/** Read manifests and tool configs into facts. `counts` supplies code-usage numbers from the index. */
export async function collectFacts(fs: ContextFs, root: string, counts: Partial<Pick<ProjectFacts, "defaultExportFiles" | "namedExportFiles" | "testNaming">> = {}): Promise<ProjectFacts> {
  const f = emptyFacts();
  Object.assign(f, counts);
  const read = (p: string) => fs.read(`${root}/${p}`);
  try {
    const pkg = JSON.parse((await read("package.json")) ?? "{}") as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; prettier?: ProjectFacts["prettier"] };
    f.scripts = pkg.scripts ?? {};
    f.deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    if (pkg.prettier) f.prettier = pkg.prettier;
  } catch {
    /* no package.json */
  }
  for (const n of [".prettierrc", ".prettierrc.json"]) {
    const t = await read(n);
    if (t) {
      try {
        f.prettier = { ...f.prettier, ...(JSON.parse(t) as ProjectFacts["prettier"]) };
      } catch {
        /* yaml or invalid: ignore */
      }
    }
  }
  const ec = await read(".editorconfig");
  const style = ec ? /indent_style\s*=\s*(tab|space)/i.exec(ec)?.[1]?.toLowerCase() : undefined;
  if (style === "tab" || style === "space") f.editorconfigIndent = style;
  for (const n of ["eslint.config.js", "eslint.config.mjs", "eslint.config.ts", ".eslintrc.json", ".eslintrc.js", ".eslintrc"]) {
    const t = await read(n);
    if (t !== null) {
      f.hasEslint = true;
      for (const m of t.matchAll(/["']?([@\w/-]+\/[\w-]+|[\w-]{4,})["']?\s*:\s*(?:["'](?:error|warn)["']|\[?\s*["']?(?:error|warn)|[12])/g)) f.eslintEnforces.add(m[1]!);
    }
  }
  const ts = await read("tsconfig.json");
  f.strictTs = !!ts && /"strict"\s*:\s*true/.test(ts);
  return f;
}

/** Warn when a rule contradicts the project's own configuration or code (section 7.3). */
export function lintRules(rules: StoredRule[], facts: ProjectFacts): LintWarning[] {
  const out: LintWarning[] = [];
  for (const r of rules) {
    const t = r.text;
    const warn = (message: string) => out.push({ ruleId: r.id, ruleName: r.name, message });

    if (/\b(?:no|avoid|never use|don'?t use|ban)\s+default exports?\b|\bnamed exports? only\b/i.test(t) && facts.defaultExportFiles > 0 && !facts.eslintEnforces.has("import/no-default-export")) {
      warn(`Bans default exports, but ESLint does not enforce it and ${facts.defaultExportFiles} file(s) use default exports. Either enforce it in ESLint or relax the rule.`);
    }
    if (/\btailwind/i.test(t) && !facts.deps.has("tailwindcss")) warn("Mentions Tailwind, but tailwindcss is not a dependency of this project.");
    if (/\b(?:no|avoid|without) semicolons?\b/i.test(t) && facts.prettier.semi !== false) warn("Says no semicolons, but the Prettier config does not set semi: false.");
    if (/\b(?:use|always use|require) semicolons?\b/i.test(t) && facts.prettier.semi === false) warn("Says to use semicolons, but the Prettier config sets semi: false.");
    if (/\btabs?\b.*\bindent|\bindent.*\btabs?\b|\buse tabs\b/i.test(t) && !/\bnot tabs\b|\bno tabs\b|\binstead of tabs\b/i.test(t) && (facts.prettier.useTabs === false || facts.editorconfigIndent === "space")) warn("Asks for tab indentation, but Prettier/.editorconfig use spaces.");
    if (/\bspaces?\b.*\bindent|\bindent.*\bspaces?\b|\buse spaces\b/i.test(t) && (facts.prettier.useTabs === true || facts.editorconfigIndent === "tab")) warn("Asks for space indentation, but Prettier/.editorconfig use tabs.");
    if (/\bvitest\b/i.test(t) && !/\bjest\b/i.test(t) && !facts.deps.has("vitest") && facts.deps.has("jest")) warn("Mentions Vitest, but the project uses Jest.");
    if (/\bjest\b/i.test(t) && !/\bvitest\b/i.test(t) && !facts.deps.has("jest") && facts.deps.has("vitest")) warn("Mentions Jest, but the project uses Vitest.");
    for (const m of t.matchAll(/\b(?:npm run|pnpm run|pnpm|yarn run|yarn)\s+([\w:-]+)/g)) {
      const s = m[1]!;
      if (["install", "add", "test", "start", "run", "i", "ci"].includes(s)) continue;
      if (Object.keys(facts.scripts).length > 0 && !(s in facts.scripts)) warn(`References the script "${s}", which is not in package.json.`);
    }
    if (secretsIn(r).length) warn("Looks like it contains a secret. Rule files are committed and sent to models: remove it.");
  }
  return out;
}

/** Secret-looking content in a rule file. */
export function secretsIn(rule: Pick<StoredRule, "text">): string[] {
  return containsSecret(rule.text) ? ["a credential or API key pattern"] : [];
}

/** Draft an AGENTS.md from the detected stack, commands and conventions, for the developer to edit. */
export function generateAgentsMd(facts: ProjectFacts, commands: ProjectCommands, projectName = "this project"): string {
  const stack: string[] = [];
  const has = (d: string) => facts.deps.has(d);
  if (has("typescript") || facts.strictTs) stack.push(`TypeScript${facts.strictTs ? " (strict)" : ""}`);
  for (const [dep, label] of [["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["svelte", "Svelte"], ["tailwindcss", "Tailwind CSS"], ["vite", "Vite"], ["express", "Express"], ["vitest", "Vitest"], ["jest", "Jest"], ["playwright", "Playwright"], ["@playwright/test", "Playwright"], ["prisma", "Prisma"]] as const) if (has(dep) && !stack.includes(label)) stack.push(label);

  const conv: string[] = [];
  const total = facts.defaultExportFiles + facts.namedExportFiles;
  if (total > 0) conv.push(facts.defaultExportFiles === 0 ? "Use named exports (the codebase has no default exports)." : facts.namedExportFiles >= facts.defaultExportFiles * 3 ? "Prefer named exports; default exports are the exception here." : "Match the export style of the surrounding file; both named and default exports are used.");
  if (facts.hasEslint) conv.push("ESLint is configured: fix lint errors instead of disabling rules.");
  if ("semi" in facts.prettier) conv.push(facts.prettier.semi === false ? "No semicolons (Prettier)." : "Use semicolons (Prettier).");
  if (facts.prettier.singleQuote) conv.push("Single quotes (Prettier).");
  const indent = facts.prettier.useTabs === true || facts.editorconfigIndent === "tab" ? "tabs" : facts.prettier.useTabs === false || facts.editorconfigIndent === "space" ? `spaces${facts.prettier.tabWidth ? ` (${facts.prettier.tabWidth})` : ""}` : null;
  if (indent) conv.push(`Indent with ${indent}.`);
  if (facts.testNaming.test + facts.testNaming.spec > 0) conv.push(`Name tests *.${facts.testNaming.spec > facts.testNaming.test ? "spec" : "test"}.* and keep them next to the code they cover.`);
  if (facts.strictTs) conv.push("TypeScript strict mode is on: no `any` to silence errors.");
  conv.push("Never delete, skip or weaken tests, and never add lint or type suppressions to make checks pass.");

  return [
    `# AGENTS.md`,
    "",
    `Instructions for AI agents working in ${projectName}. Generated by Forge from the repository: edit freely.`,
    "",
    "## Stack",
    ...(stack.length ? stack.map((s) => `- ${s}`) : ["- (not detected)"]),
    "",
    renderCommandsSection(commands).trimEnd(),
    "",
    "## Conventions",
    ...conv.map((c) => `- ${c}`),
    "",
    "## Notes",
    "- Add architecture notes, gotchas and areas that need care here.",
    "",
  ].join("\n");
}
