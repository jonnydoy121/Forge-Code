// Reusable prompts kept in the repo (.forge/prompts/<name>.md), invoked as slash commands: `/review src/a.ts`.
// Shareable team workflows. `$ARGUMENTS` in the body is replaced by whatever follows the command name.

import { parseFrontmatter } from "./frontmatter";

export interface SavedPrompt {
  name: string;
  description: string;
  body: string;
}

export interface PromptFs {
  read(path: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export function parsePromptFile(file: string, text: string): SavedPrompt | null {
  const name = file.replace(/\.md$/i, "");
  if (!NAME.test(name)) return null;
  const { data, body } = parseFrontmatter(text);
  const trimmed = body.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 100);
  return { name, description: typeof data.description === "string" && data.description ? data.description : firstLine, body: trimmed };
}

export async function loadPrompts(fs: PromptFs, dir: string): Promise<SavedPrompt[]> {
  let files: string[] = [];
  try {
    files = (await fs.list(dir)).filter((f) => /\.md$/i.test(f));
  } catch {
    return []; // no prompts folder
  }
  const out: SavedPrompt[] = [];
  for (const f of files) {
    const text = await fs.read(`${dir}/${f}`).catch(() => null);
    const p = text === null ? null : parsePromptFile(f, text);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `/name rest of line` -> the prompt text to send, or null when the input is not a known slash command. */
export function expandPrompt(input: string, prompts: SavedPrompt[]): { name: string; prompt: string } | null {
  const m = /^\/([A-Za-z0-9][\w-]*)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return null;
  const p = prompts.find((x) => x.name.toLowerCase() === m[1]!.toLowerCase());
  if (!p) return null;
  const args = (m[2] ?? "").trim();
  // A function replacer, so "$&" or "$1" inside the user's arguments are never interpreted.
  const prompt = p.body.includes("$ARGUMENTS") ? p.body.replace(/\$ARGUMENTS/g, () => args) : args ? `${p.body}\n\n${args}` : p.body;
  return { name: p.name, prompt };
}

/** Autocomplete: commands matching what has been typed after the slash (only while still typing the name). */
export function matchPrompts(input: string, prompts: SavedPrompt[]): SavedPrompt[] {
  const m = /^\/([\w-]*)$/.exec(input);
  if (!m) return [];
  const q = m[1]!.toLowerCase();
  return prompts.filter((p) => p.name.toLowerCase().startsWith(q));
}
