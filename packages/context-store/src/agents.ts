// Specialist agents: a coordinator hands a task to a specialist that has its own instructions, its own (narrower) set of tools and
// a fresh context. A specialist is a markdown file, `.forge/agents/<name>.md` in the repository or `~/.forge/agents/<name>.md`:
//
//   ---
//   description: Reviews code for security problems
//   tools: [read_file, grep, find_files]      # optional: only these of the read-only tools (default: all of them)
//   tier: architect                           # optional: scout, builder or architect (which model tier answers; default builder)
//   ---
//   You are a security reviewer. Look for injection, unsafe deserialisation, ... Report findings with file and line.
//
// Specialists only read and report. They cannot edit, run commands or call tools that need permission, so a specialist file in a
// repository you cloned cannot do anything a plain `delegate` could not.
import { asList, parseFrontmatter } from "./frontmatter";

export type AgentTier = "scout" | "builder" | "architect";

export interface AgentDef {
  name: string;
  description: string;
  /** The read-only tools it may use, or null for all of them. */
  tools: string[] | null;
  tier: AgentTier | null;
  /** What the specialist is told about its job (the body of the file). */
  instructions: string;
  source: "project" | "user";
  /** Why parts of the file were ignored (an unknown tier), shown to the developer. */
  problems: string[];
}

export interface AgentFs {
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;
const TIERS: readonly string[] = ["scout", "builder", "architect"];

async function loadFrom(fs: AgentFs, dir: string, source: AgentDef["source"]): Promise<AgentDef[]> {
  let files: string[] = [];
  try {
    files = await fs.list(dir);
  } catch {
    return []; // no agents folder
  }
  const out: AgentDef[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    if (!NAME.test(name)) continue;
    const text = await fs.read(`${dir}/${file}`).catch(() => null);
    if (text === null) continue;
    const { data, body } = parseFrontmatter(text);
    const instructions = body.trim();
    if (!instructions) continue; // a specialist with nothing to say about its job is not one
    const problems: string[] = [];
    const description = typeof data.description === "string" && data.description.trim() ? data.description.trim() : (instructions.split("\n")[0] ?? "").replace(/^#+\s*/, "").slice(0, 160);
    const tools = data.tools === undefined ? null : asList(data.tools).map((t) => t.trim()).filter(Boolean);
    let tier: AgentTier | null = null;
    if (data.tier !== undefined) {
      const t = typeof data.tier === "string" ? data.tier.trim().toLowerCase() : "";
      if (TIERS.includes(t)) tier = t as AgentTier;
      else problems.push(`tier "${String(data.tier)}" is not scout, builder or architect, so the default is used`);
    }
    out.push({ name, description, tools: tools && tools.length ? tools : null, tier, instructions, source, problems });
  }
  return out;
}

/** The repository's specialists and the user's own; a project one overrides a user one of the same name. */
export async function loadAgents(fs: AgentFs, projectDir: string, userDir?: string): Promise<AgentDef[]> {
  const project = await loadFrom(fs, projectDir, "project");
  const user = userDir ? (await loadFrom(fs, userDir, "user")).filter((u) => !project.some((p) => p.name.toLowerCase() === u.name.toLowerCase())) : [];
  return [...project, ...user].sort((a, b) => a.name.localeCompare(b.name));
}

/** One line per specialist, for the coordinator to know who exists. */
export function agentsIndex(agents: Pick<AgentDef, "name" | "description">[]): string {
  return agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
}
