import { globToRegExp, type Rule } from "@forge/protocol";
import { asList, asString, parseFrontmatter } from "./frontmatter";

export interface ContextFs {
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
}

export type RuleKind = "user" | "agents-md" | "import" | "nested-agents-md" | "scoped";
export type Activation = "always" | "auto" | "agent" | "manual";

export interface StoredRule {
  id: string;
  name: string;
  kind: RuleKind;
  /** workspace-relative file the rule came from ("" for user rules) */
  label: string;
  /** For nested AGENTS.md: the directory it governs (workspace-relative, "" = root). */
  dir?: string;
  text: string;
  description?: string;
  globs: string[];
  activation: Activation;
}

/** Why a rule applies to the current work. */
export interface AppliedRule {
  rule: StoredRule;
  reasons: string[];
}

// Precedence, lowest to highest (section 7.1). Later entries override earlier ones on conflict.
const RANK: Record<RuleKind, number> = { user: 0, "agents-md": 1, import: 1, "nested-agents-md": 2, scoped: 3 };

// `.forgerules` is Forge-Code's own name for a plain-text rules file at the repo root; the others are what other tools use.
const IMPORTS = [".forgerules", "CLAUDE.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function toActivation(v: string | undefined, hasGlobs: boolean, hasDescription: boolean, alwaysApply?: boolean): Activation {
  if (v === "always" || v === "auto" || v === "agent" || v === "manual") return v;
  if (alwaysApply) return "always";
  if (hasGlobs) return "auto";
  return hasDescription ? "agent" : "always";
}

export class RuleEngine {
  private loaded: StoredRule[] | null = null;
  private nestedCache = new Map<string, StoredRule | null>();

  constructor(
    private fs: ContextFs,
    private root: string,
    private userRules: () => string = () => "",
  ) {}

  /** Forget cached files (call when rule files change). */
  invalidate() {
    this.loaded = null;
    this.nestedCache.clear();
  }

  /** User rules, root AGENTS.md, imported tool rule files, and scoped .forge/rules. */
  async load(): Promise<StoredRule[]> {
    if (this.loaded) return this.loaded;
    const out: StoredRule[] = [];
    const user = this.userRules().trim();
    if (user) out.push({ id: "user", name: "User rules", kind: "user", label: "Forge settings", text: user, globs: [], activation: "always" });

    const agents = await this.fs.read(`${this.root}/AGENTS.md`);
    if (agents?.trim()) out.push({ id: "agents-md", name: "AGENTS.md", kind: "agents-md", label: "AGENTS.md", dir: "", text: agents.trim(), globs: [], activation: "always" });

    for (const f of IMPORTS) {
      const t = await this.fs.read(`${this.root}/${f}`);
      if (t?.trim()) out.push({ id: `import:${f}`, name: f, kind: "import", label: f, text: t.trim(), globs: [], activation: "always" });
    }
    for (const dir of [".cursor/rules"]) {
      for (const n of (await this.fs.list(`${this.root}/${dir}`)).filter((x) => /\.mdc?$/.test(x)).sort()) {
        const t = await this.fs.read(`${this.root}/${dir}/${n}`);
        if (!t) continue;
        const { data, body } = parseFrontmatter(t);
        const globs = asList(data.globs);
        out.push({
          id: `import:${dir}/${n}`,
          name: `${dir}/${n}`,
          kind: "import",
          label: `${dir}/${n}`,
          text: body.trim(),
          description: asString(data.description),
          globs,
          activation: toActivation(undefined, globs.length > 0, !!asString(data.description), data.alwaysApply === true),
        });
      }
    }
    for (const n of (await this.fs.list(`${this.root}/.forge/rules`)).filter((x) => x.endsWith(".md")).sort()) {
      const t = await this.fs.read(`${this.root}/.forge/rules/${n}`);
      if (!t) continue;
      const { data, body } = parseFrontmatter(t);
      const globs = asList(data.globs);
      out.push({
        id: `scoped:${n}`,
        name: n.replace(/\.md$/, ""),
        kind: "scoped",
        label: `.forge/rules/${n}`,
        text: body.trim(),
        description: asString(data.description),
        globs,
        activation: toActivation(asString(data.activation), globs.length > 0, !!asString(data.description)),
      });
    }
    this.loaded = out;
    return out;
  }

  /** AGENTS.md files between the root and `file`'s directory (excluding the root one), nearest last. */
  private async nestedFor(file: string): Promise<StoredRule[]> {
    const parts = file.split("/").slice(0, -1);
    const found: StoredRule[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.nestedCache.has(dir)) {
        const t = await this.fs.read(`${this.root}/${dir}/AGENTS.md`);
        this.nestedCache.set(dir, t?.trim() ? { id: `nested:${dir}`, name: `${dir}/AGENTS.md`, kind: "nested-agents-md", label: `${dir}/AGENTS.md`, dir, text: t.trim(), globs: [], activation: "always" } : null);
      }
      const r = this.nestedCache.get(dir);
      if (r) found.push(r);
    }
    return found;
  }

  /**
   * Rules that apply to the given files, in precedence order (later overrides earlier), each with the reasons it applies.
   * `files` are workspace-relative, forward-slash paths. Only the glob/nesting/mention rules decide applicability,
   * so a glob rule for src/components/** provably does not apply to server/.
   */
  async applicable(files: string[], opts: { mentioned?: string[]; agentPicked?: string[] } = {}): Promise<AppliedRule[]> {
    const all = await this.load();
    const mentioned = new Set((opts.mentioned ?? []).map((m) => m.toLowerCase()));
    const picked = new Set((opts.agentPicked ?? []).map((m) => m.toLowerCase()));
    const byId = new Map<string, AppliedRule>();
    const add = (rule: StoredRule, reason: string) => {
      const cur = byId.get(rule.id);
      if (cur) {
        if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
      } else byId.set(rule.id, { rule, reasons: [reason] });
    };

    for (const r of all) {
      const named = mentioned.has(r.name.toLowerCase()) || mentioned.has(slug(r.name));
      if (named) add(r, "mentioned with @");
      if (r.activation === "always") add(r, r.kind === "user" ? "always (your user rules)" : r.kind === "import" ? `always (imported from ${r.label})` : r.kind === "scoped" ? "always" : "always (repo root)");
      else if (r.activation === "auto") {
        for (const g of r.globs) {
          const re = globToRegExp(g);
          if (files.some((f) => re.test(f))) add(r, `glob match: ${g}`);
        }
      } else if (r.activation === "agent" && picked.has(r.name.toLowerCase())) add(r, "chosen by the agent from its description");
    }
    for (const f of new Set(files)) for (const n of await this.nestedFor(f)) add(n, `nested AGENTS.md covers ${n.dir}/`);

    return [...byId.values()].sort((a, b) => RANK[a.rule.kind] - RANK[b.rule.kind] || (a.rule.dir?.length ?? 0) - (b.rule.dir?.length ?? 0) || a.rule.label.localeCompare(b.rule.label));
  }

  /** Rules the model can choose to load (activation: agent) that are not already applied. */
  async agentChoosable(applied: AppliedRule[]): Promise<StoredRule[]> {
    const have = new Set(applied.map((a) => a.rule.id));
    return (await this.load()).filter((r) => r.activation === "agent" && !have.has(r.id));
  }

  async manualRules(): Promise<StoredRule[]> {
    return (await this.load()).filter((r) => r.activation === "manual");
  }

  /** Render applicable rules for the system prompt. */
  static render(applied: AppliedRule[]): string {
    if (applied.length === 0) return "";
    return [
      "Follow these project rules. They are listed from lowest to highest precedence: where rules conflict, the later one wins, and the user's current request overrides all of them.",
      ...applied.map((a) => `### ${a.rule.name} (${a.rule.label})\n${a.rule.text}`),
    ].join("\n\n");
  }

  /** Convert to the protocol's Rule shape. */
  static toProtocol(a: AppliedRule): Rule {
    return { id: a.rule.id, source: a.rule.label, text: a.rule.text, globs: a.rule.globs, activation: a.rule.activation };
  }
}
