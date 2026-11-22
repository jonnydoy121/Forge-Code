// Detect a project's build/lint/test commands from manifests and CI config, and round-trip them
// through a `## Commands` section in the rules file so the developer can correct them.

export interface ProjectCommands {
  build?: string;
  typecheck?: string;
  lint?: string;
  format?: string;
  test?: string;
  /** Template with a {file} placeholder. */
  testFile?: string;
  dev?: string;
  /** where each command came from, for display */
  sources: Record<string, string>;
}

export interface DiscoveryFs {
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
}

const KEYS = ["build", "typecheck", "lint", "format", "test", "testFile", "dev"] as const;
export type CommandKey = (typeof KEYS)[number];
const LABEL: Record<CommandKey, string> = { build: "build", typecheck: "typecheck", lint: "lint", format: "format", test: "test", testFile: "test:file", dev: "dev" };

const NO_TEST = /no test specified/i;

export async function discoverCommands(fs: DiscoveryFs, root: string): Promise<ProjectCommands> {
  const out: ProjectCommands = { sources: {} };
  const set = (k: CommandKey, v: string | undefined, source: string) => {
    if (v && !out[k]) {
      out[k] = v;
      out.sources[k] = source;
    }
  };
  const read = (f: string) => fs.read(`${root}/${f}`);

  // --- Node ---
  const pkgText = await read("package.json");
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const pm = (await read("pnpm-lock.yaml")) !== null ? "pnpm" : (await read("yarn.lock")) !== null ? "yarn" : (await read("bun.lockb")) !== null ? "bun" : "npm";
      const run = (name: string) => (pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`);
      const pick = (...names: string[]) => names.find((n) => scripts[n] && !NO_TEST.test(scripts[n]!));
      const from = (k: CommandKey, ...names: string[]) => {
        const n = pick(...names);
        if (n) set(k, n === "test" ? (pm === "npm" ? "npm test" : `${pm} test`) : run(n), `package.json scripts.${n}`);
      };
      from("build", "build");
      from("typecheck", "typecheck", "type-check", "check-types", "tsc");
      from("lint", "lint");
      from("format", "format:check", "format-check", "check-format", "format");
      from("test", "test");
      from("dev", "dev", "start");
      if (!out.typecheck && deps.typescript && (await read("tsconfig.json")) !== null) set("typecheck", "npx tsc --noEmit", "tsconfig.json + typescript dependency");
      const testScript = scripts.test ?? "";
      if (deps.vitest || /vitest/.test(testScript)) set("testFile", "npx vitest run {file}", "vitest");
      else if (deps.jest || /jest/.test(testScript)) set("testFile", "npx jest {file}", "jest");
      else if (/node\s+--test/.test(testScript)) set("testFile", "node --test {file}", "node:test");
      if (!out.test && deps.vitest) set("test", "npx vitest run", "vitest dependency");
    } catch {
      /* malformed package.json: fall through to other detectors */
    }
  }

  // --- Make ---
  const make = await read("Makefile");
  if (make) {
    const targets = new Set([...make.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)].map((m) => m[1]!));
    const t = (k: CommandKey, ...names: string[]) => {
      const n = names.find((x) => targets.has(x));
      if (n) set(k, `make ${n}`, `Makefile target ${n}`);
    };
    t("build", "build", "all");
    t("typecheck", "typecheck", "check");
    t("lint", "lint");
    t("format", "format-check", "fmt-check", "format", "fmt");
    t("test", "test", "tests");
    t("dev", "dev", "run");
  }

  // --- Python ---
  const py = await read("pyproject.toml");
  if (py) {
    const has = (re: RegExp) => re.test(py);
    if (has(/\[tool\.pytest|pytest/)) {
      set("test", "pytest", "pyproject.toml (pytest)");
      set("testFile", "pytest {file}", "pyproject.toml (pytest)");
    }
    if (has(/\[tool\.ruff|ruff/)) {
      set("lint", "ruff check .", "pyproject.toml (ruff)");
      set("format", "ruff format --check .", "pyproject.toml (ruff)");
    }
    if (has(/\[tool\.mypy|mypy/)) set("typecheck", "mypy .", "pyproject.toml (mypy)");
    else if (has(/pyright/)) set("typecheck", "pyright", "pyproject.toml (pyright)");
  }

  // --- Rust ---
  if ((await read("Cargo.toml")) !== null) {
    set("build", "cargo build", "Cargo.toml");
    set("typecheck", "cargo check", "Cargo.toml");
    set("lint", "cargo clippy -- -D warnings", "Cargo.toml");
    set("format", "cargo fmt --check", "Cargo.toml");
    set("test", "cargo test", "Cargo.toml");
    set("dev", "cargo run", "Cargo.toml");
  }

  // --- Go ---
  if ((await read("go.mod")) !== null) {
    set("build", "go build ./...", "go.mod");
    set("typecheck", "go vet ./...", "go.mod");
    set("format", "gofmt -l .", "go.mod");
    set("test", "go test ./...", "go.mod");
  }

  // --- CI as a last resort ---
  const wf = await fs.list(`${root}/.github/workflows`).catch(() => [] as string[]);
  for (const name of wf.filter((n) => /\.ya?ml$/.test(n))) {
    const text = await fs.read(`${root}/.github/workflows/${name}`);
    for (const m of text?.matchAll(/^\s*-?\s*run:\s*(.+)$/gm) ?? []) {
      const cmd = m[1]!.trim();
      if (/\binstall\b|\bci\b$|\|$/.test(cmd) || cmd.startsWith("|")) continue;
      const src = `.github/workflows/${name}`;
      if (/\b(lint)\b/.test(cmd)) set("lint", cmd, src);
      else if (/\btypecheck\b|\btsc\b/.test(cmd)) set("typecheck", cmd, src);
      else if (/\btest\b/.test(cmd)) set("test", cmd, src);
      else if (/\bbuild\b/.test(cmd)) set("build", cmd, src);
    }
  }
  return out;
}

export function renderCommandsSection(c: ProjectCommands): string {
  const lines = KEYS.filter((k) => c[k]).map((k) => `- ${LABEL[k]}: ${c[k]}`);
  return ["## Commands", "", "<!-- Detected by Forge. Correct anything that is wrong; your edits take precedence. -->", ...lines, ""].join("\n");
}

const HEADING = /^##\s+Commands\s*$/m;
export const hasCommandsSection = (md: string) => HEADING.test(md);

/** Parse the `## Commands` section. Returns only what the developer wrote. */
export function parseCommandsSection(md: string): Partial<Record<CommandKey, string>> {
  const m = HEADING.exec(md);
  if (!m) return {};
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^#{1,2}\s/m);
  const body = end >= 0 ? rest.slice(0, end) : rest;
  const out: Partial<Record<CommandKey, string>> = {};
  for (const line of body.split("\n")) {
    const lm = /^\s*[-*]\s+([\w:]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!lm) continue;
    const key = KEYS.find((k) => LABEL[k] === lm[1] || k === lm[1]);
    if (key) out[key] = lm[2]!.replace(/^`(.*)`$/, "$1");
  }
  return out;
}

/** Add a Commands section to a rules file unless it already has one (developer corrections are never overwritten). */
export function withCommandsSection(existing: string | null, c: ProjectCommands): string | null {
  const section = renderCommandsSection(c);
  if (existing === null) return `# AGENTS.md\n\n${section}`;
  if (hasCommandsSection(existing)) return null;
  return `${existing.replace(/\s*$/, "")}\n\n${section}`;
}

/** Discovered commands overlaid with whatever the developer wrote in the rules file. */
export async function loadCommands(fs: DiscoveryFs, root: string): Promise<ProjectCommands> {
  const found = await discoverCommands(fs, root);
  const rules = await fs.read(`${root}/AGENTS.md`);
  if (!rules) return found;
  const mine = parseCommandsSection(rules);
  for (const k of KEYS) {
    if (mine[k]) {
      found[k] = mine[k];
      found.sources[k] = "AGENTS.md ## Commands";
    }
  }
  return found;
}
