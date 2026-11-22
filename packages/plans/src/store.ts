import { parsePlan, planPath, setPlanStatus, setStepStatus, slugify, type Plan, type PlanStatus, type StepStatus } from "./plan";

export interface PlanFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(dir: string): Promise<string[]>;
}

/** Reads and writes plan files under <root>/.forge/plans. */
export class PlanStore {
  constructor(
    private fs: PlanFs,
    private root: string,
    private onChange?: () => void,
  ) {}

  abs(slug: string) {
    return `${this.root}/${planPath(slug)}`;
  }

  async list(): Promise<{ slug: string; plan: Plan }[]> {
    const names = (await this.fs.list(`${this.root}/.forge/plans`)).filter((n) => n.endsWith(".md")).sort();
    const out: { slug: string; plan: Plan }[] = [];
    for (const n of names) {
      const slug = n.slice(0, -3);
      const md = await this.fs.read(this.abs(slug));
      if (md) out.push({ slug, plan: parsePlan(md, slug) });
    }
    return out;
  }

  async read(slug: string): Promise<{ md: string; plan: Plan } | null> {
    const md = await this.fs.read(this.abs(slug));
    return md === null ? null : { md, plan: parsePlan(md, slug) };
  }

  /** Create or replace a plan. The slug comes from the title unless given; it can never escape .forge/plans. */
  async write(markdown: string, slug?: string): Promise<string> {
    const s = slugify(slug ?? parsePlan(markdown).title);
    await this.fs.write(this.abs(s), markdown.endsWith("\n") ? markdown : markdown + "\n");
    this.onChange?.();
    return s;
  }

  private async update(slug: string, f: (md: string) => string) {
    const cur = await this.read(slug);
    if (!cur) throw new Error(`no plan named ${slug}`);
    const next = f(cur.md);
    if (next !== cur.md) {
      await this.fs.write(this.abs(slug), next);
      this.onChange?.();
    }
  }

  setStep(slug: string, n: number, status: StepStatus) {
    return this.update(slug, (md) => setStepStatus(md, n, status));
  }

  setStatus(slug: string, status: PlanStatus) {
    return this.update(slug, (md) => setPlanStatus(md, status));
  }

  edit(slug: string, f: (md: string) => string) {
    return this.update(slug, f);
  }
}
