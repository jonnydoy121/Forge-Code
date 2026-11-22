// Deciding what a message means, conservatively. Execution is never triggered by ambiguous wording.

export type Intent = "build" | "edit-plan" | "ambiguous" | "none";

/** Phrases that clearly mean "start executing the approved plan". Must be (nearly) the whole message. */
const BUILD = /^(?:ok(?:ay)?[,.! ]+|yes[,.! ]+|please\s+)?(?:go(?: ahead)?|build(?: it| the plan| this)?|start building|execute(?: the plan| it)?|implement(?: the plan| it)?|proceed|do it|run the plan|let'?s (?:go|build|do it))[.! ]*$/i;

/** Phrases about changing the plan itself. */
const EDIT = new RegExp(
  [
    String.raw`\b(?:update|change|edit|revise|rewrite|modify|adjust|amend|rework|tweak)\b[^.!?]*\b(?:plan|steps?|tasks?)\b`,
    String.raw`\b(?:add|remove|reorder|drop|delete|insert|split|merge)\s+(?:a |an |the |one |another )?(?:new )?(?:step|task)s?\b`,
    String.raw`\b(?:plan|steps?|tasks?)\b[^.!?]*\b(?:update|change|revise|needs?|should)\b`,
  ].join("|"),
  "i",
);

const BUILD_AFTER_AND = new RegExp(String.raw`\b(?:and|then)\s+(?:go|build|execute|proceed|start|implement)\b|,\s*(?:go|build|execute|proceed|start|implement)\b`, "i");
const BUILD_WORDS = new RegExp(String.raw`\b(?:go ahead|build it|execute|proceed|start building)\b`, "i");

/**
 * "go" -> build. "update the plan" -> edit-plan. A message that mixes both ("update the plan and go") is
 * ambiguous and executes nothing: the developer must use the Build action or a plain, unqualified instruction.
 */
export function classifyIntent(text: string): Intent {
  const t = text.trim();
  if (!t) return "none";
  const wantsBuild = BUILD.test(t);
  const wantsEdit = EDIT.test(t);
  if (wantsBuild && !wantsEdit) return "build";
  if (wantsEdit && !wantsBuild) return BUILD_AFTER_AND.test(t) ? "ambiguous" : "edit-plan";
  if (wantsBuild && wantsEdit) return "ambiguous";
  return BUILD_WORDS.test(t) ? "ambiguous" : "none";
}

const LARGE_WORDS = new RegExp(
  String.raw`\b(?:refactor|migrate|migration|rewrite|re-?architect|overhaul|redesign|add (?:a )?(?:new )?feature|implement (?:a |an |the )?\w+|across (?:the )?(?:repo|codebase|project|files|services)|every (?:caller|usage|file)|all (?:callers|usages|files)|several files|multiple files|end[- ]to[- ]end|from scratch|rename .* everywhere|upgrade)\b`,
  "i",
);

/** Heuristic: should Forge suggest Plan mode for this request? */
export function looksLarge(prompt: string): boolean {
  const t = prompt.trim();
  if (t.length < 15) return false;
  const files = new Set(t.match(/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|h|md|json)\b/g) ?? []);
  return LARGE_WORDS.test(t) || files.size >= 3 || t.split(/\n|\band\b/i).length > 5;
}
