// Automatic skill selection: which of the repository's skills clearly cover the task being asked, so their instructions can be put
// in front of the model without waiting for it to notice the index and call `use_skill`.
//
// Deliberately cheap and conservative: a lexical match (no model call, no embeddings) that weights rare words more than common ones and
// stays silent unless the evidence is clear. A skill that is loaded when it is not needed costs tokens and can mislead; a skill that is
// missed is only the status quo (the model can still load it itself from the index).
import type { Skill } from "./skills";

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our so that the their them then there these this to up us was we what when where which who why will with you your please make need want add use using get new file files code thing".split(" "),
);

/** Lower-case words with a light stem, so "testing", "tests" and "tested" meet. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}
function stem(w: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) if (w.length > suffix.length + 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  return w;
}

export interface SkillMatch {
  skill: Skill;
  score: number;
  /** the words of the task that matched this skill (shown to the developer so the choice is explainable) */
  matched: string[];
}

export interface MatchOptions {
  /** most skills to apply at once (default 2: more crowds the context and the instructions start to conflict) */
  max?: number;
  /** lowest score that counts (default 3) */
  minScore?: number;
}

/**
 * The skills whose name and description match the task, best first. A skill needs at least two distinct matching words, so a single
 * word that happens to be in a skill's name ("release the lock", "review this SQL") cannot switch it on.
 */
export function matchSkills(task: string, skills: Skill[], opts: MatchOptions = {}): SkillMatch[] {
  const max = opts.max ?? 2;
  const minScore = opts.minScore ?? 3;
  const taskWords = new Set(words(task));
  if (taskWords.size === 0 || skills.length === 0) return [];

  // Words that appear in every skill say nothing about which one applies: weight each word by how rare it is across the skills.
  const docs = skills.map((s) => ({ name: new Set(words(s.name.replace(/[-_]/g, " "))), text: new Set(words(`${s.name.replace(/[-_]/g, " ")} ${s.description}`)) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.text) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(2 + skills.length / (df.get(w) ?? 1));

  const out: SkillMatch[] = [];
  skills.forEach((skill, i) => {
    const d = docs[i]!;
    const matched = [...taskWords].filter((w) => d.text.has(w));
    if (matched.length === 0) return;
    if (matched.length < 2) return; // one shared word is too often a coincidence: "release the lock", "review this SQL"
    const score = matched.reduce((sum, w) => sum + idf(w) * (d.name.has(w) ? 2 : 1), 0);
    if (score >= minScore) out.push({ skill, score, matched });
  });
  return out.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name)).slice(0, max);
}

const MAX_BODY = 4000;

/** The prompt section for matched skills: their instructions, labelled with why they were applied. Empty when nothing matched. */
export function renderMatchedSkills(matches: SkillMatch[]): string {
  return matches
    .map((m) => {
      const body = m.skill.body.length > MAX_BODY ? `${m.skill.body.slice(0, MAX_BODY)}\n[... the rest is available with use_skill]` : m.skill.body;
      return `### House rules from "${m.skill.name}" (they apply because the request mentions ${m.matched.join(", ")})
${body}`;
    })
    .join("\n\n");
}
