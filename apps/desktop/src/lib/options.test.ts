import { describe, expect, it } from "vitest";
import { approvedPrompt, buildOptionsPrompt, optionLetter, parseOptions, type Option } from "./options";

const opt = (over: Partial<Option> = {}): Option => ({ title: "Cache in memory", summary: "Keep results in a Map.", files: ["src/api.ts"], tradeoff: "Lost on restart.", size: "small", ...over });
const reply = (options: unknown[]) => JSON.stringify({ options });

describe("buildOptionsPrompt", () => {
  it("asks for approaches, not code, in a fixed JSON shape, and includes the request, the open file and the repo map", () => {
    const p = buildOptionsPrompt("Add caching to the API client", "src/api.ts: fetchUser()", "src/api.ts");
    expect(p).toContain("Do NOT write code");
    expect(p).toContain('{"options":[{"title"');
    expect(p).toContain("Request: Add caching to the API client");
    expect(p).toContain("src/api.ts: fetchUser()");
    expect(p).toContain("has this file open: src/api.ts");
  });

  it("leaves out what it does not have, and caps a huge repo map", () => {
    const p = buildOptionsPrompt("do it", null, null);
    expect(p).not.toContain("Repo map");
    expect(p).not.toContain("open:");
    expect(buildOptionsPrompt("do it", "x".repeat(50_000)).length).toBeLessThan(5000);
  });
});

describe("parseOptions", () => {
  it("reads two or three options", () => {
    expect(parseOptions(reply([opt(), opt({ title: "Disk cache", size: "large" })]))).toHaveLength(2);
    const three = parseOptions(reply([opt(), opt({ title: "B" }), opt({ title: "C" })]))!;
    expect(three.map((o) => o.title)).toEqual(["Cache in memory", "B", "C"]);
  });

  it("copes with a code fence, or a sentence before and after the JSON", () => {
    const body = reply([opt(), opt({ title: "B" })]);
    expect(parseOptions("```json\n" + body + "\n```")).toHaveLength(2);
    expect(parseOptions(`Sure! Here are two ways: ${body} Let me know.`)).toHaveLength(2);
    expect(parseOptions(JSON.stringify([opt(), opt({ title: "B" })]).replace(/^/, '{"options":').concat("}"))).toHaveLength(2);
  });

  it("reads a bare array of options too, fenced or not (what a 1.5B model returned instead of the object)", () => {
    const two = JSON.stringify([opt(), opt({ title: "B" })], null, 2);
    expect(parseOptions(["```json", two, "```"].join(String.fromCharCode(10)))).toHaveLength(2);
    expect(parseOptions(two)!.map((o) => o.title)).toEqual(["Cache in memory", "B"]);
    expect(parseOptions(`Here you go: ${two}`)).toHaveLength(2);
  });

  it("keeps at most three, and skips entries without a title or summary", () => {
    const many = reply([opt({ title: "1" }), opt({ title: "" }), opt({ summary: "" }), opt({ title: "2" }), opt({ title: "3" }), opt({ title: "4" })]);
    expect(parseOptions(many)!.map((o) => o.title)).toEqual(["1", "2", "3"]);
  });

  it("is null unless there are at least two usable options (one option is not a choice)", () => {
    expect(parseOptions(reply([opt()]))).toBeNull();
    expect(parseOptions(reply([]))).toBeNull();
    expect(parseOptions(reply([opt(), { title: "no summary" }]))).toBeNull();
    for (const bad of ["", "no json here", "{", '{"options": "nope"}', '{"options": [1, 2]}', "[]"]) expect(parseOptions(bad), bad).toBeNull();
  });

  it("normalises: unknown sizes become medium, missing files become none, long text is cut, whitespace is collapsed", () => {
    const [a, b] = parseOptions(reply([opt({ size: "huge" as never, files: undefined as never, summary: "word ".repeat(200), title: "  Spaced \n title " }), opt({ files: ["a", "", 3 as never, "b"] })]))!;
    expect(a!.size).toBe("medium");
    expect(a!.files).toEqual([]);
    expect(a!.summary.length).toBeLessThanOrEqual(400);
    expect(a!.title).toBe("Spaced title");
    expect(b!.files).toEqual(["a", "b"]);
  });

  it("survives braces and quotes inside the text of an option", () => {
    const o = parseOptions(reply([opt({ summary: 'Use a { } block and "quotes"' }), opt({ title: "B" })]))!;
    expect(o[0]!.summary).toBe('Use a { } block and "quotes"');
  });
});

describe("approvedPrompt", () => {
  it("carries the request and the chosen approach and tells the agent not to build the others", () => {
    const p = approvedPrompt("Add caching to the API client", opt(), 1);
    expect(p).toContain("Add caching to the API client");
    expect(p).toContain("Approved approach (option B: Cache in memory): Keep results in a Map.");
    expect(p).toContain("Files likely involved: src/api.ts");
    expect(p).toContain("Do not implement the other options");
  });
  it("skips the file line when the option names no files", () => {
    expect(approvedPrompt("x", opt({ files: [] }), 0)).not.toContain("Files likely involved");
    expect(optionLetter(0)).toBe("A");
    expect(optionLetter(2)).toBe("C");
  });
});
