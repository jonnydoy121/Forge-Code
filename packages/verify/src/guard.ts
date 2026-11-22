import { diffHunks, splitLines } from "@forge/review";
import { isTestFile } from "./checks";

const SUPPRESSIONS: [RegExp, string][] = [
  [/eslint-disable/, "adds an eslint-disable"],
  [/@ts-ignore|@ts-nocheck|@ts-expect-error/, "adds a TypeScript suppression"],
  [/#\s*noqa\b|#\s*type:\s*ignore|#\s*pylint:\s*disable|#\s*pyright:\s*ignore/, "adds a Python lint/type suppression"],
  [/#\[allow\(|#!\[allow\(/, "adds a Rust #[allow(...)]"],
  [/\/\/\s*nolint/, "adds a nolint"],
  [/as\s+any\b|<any>/, "casts to any"],
];

const SKIPS: [RegExp, string][] = [
  [/\b(?:it|test|describe)\.(?:skip|todo)\b|\bx(?:it|describe|test)\(/, "skips a test"],
  [/@pytest\.mark\.(?:skip|xfail)|\bpytest\.skip\(|@unittest\.skip/, "skips a test"],
  [/\bt\.Skip(?:f|Now)?\(/, "skips a test"],
  [/#\[ignore\]/, "ignores a test"],
];

const ASSERTION = /\bexpect\(|\bassert\w*[.(]|\bassert\s|\.should\b|\bt\.(?:Error|Fatal)f?\(|assert_eq!|assert!\(/;

/**
 * Detect edits that make checks pass by weakening them: added suppressions, skipped tests, or fewer
 * assertions in a test file. Returns human-readable reasons; empty means nothing suspicious. The caller
 * forces such edits through developer approval even in auto-apply modes.
 */
export function detectWeakening(path: string, before: string | null, after: string | null): string[] {
  const reasons = new Set<string>();
  const test = isTestFile(path);
  if (test && before !== null && after === null) reasons.add("deletes a test file");
  if (after === null) return [...reasons];
  const hunks = diffHunks(splitLines(before ?? ""), splitLines(after));
  const added = hunks.flatMap((h) => h.newLines);
  const removed = hunks.flatMap((h) => h.oldLines);
  for (const l of added) {
    for (const [re, why] of SUPPRESSIONS) if (re.test(l)) reasons.add(why);
    if (test) for (const [re, why] of SKIPS) if (re.test(l)) reasons.add(why);
  }
  if (test) {
    const count = (ls: string[]) => ls.filter((l) => ASSERTION.test(l)).length;
    const lost = count(removed) - count(added);
    if (lost > 0) reasons.add(`removes ${lost} assertion${lost === 1 ? "" : "s"} from a test file`);
    // loosened expectations: same number of assertions, but a strict matcher became a weak one
    const weak = /toBeTruthy\(|toBeDefined\(|expect\.anything\(|assert\.ok\(|assert\(true\)|assert True$/;
    if (added.some((l) => weak.test(l)) && !removed.some((l) => weak.test(l))) reasons.add("replaces an assertion with a weaker one");
  }
  return [...reasons];
}
