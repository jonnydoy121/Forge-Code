import { describe, expect, it } from "vitest";
import { languageFromFence, toSegments, tokenClass } from "./highlight";

describe("tokenClass", () => {
  it("groups Monaco's token types into a few colour classes", () => {
    expect(tokenClass("keyword.ts")).toBe("keyword");
    expect(tokenClass("comment.doc.ts")).toBe("comment");
    expect(tokenClass("string.escape.ts")).toBe("string");
    expect(tokenClass("regexp.ts")).toBe("string");
    expect(tokenClass("number.float.ts")).toBe("number");
    expect(tokenClass("type.identifier.ts")).toBe("type");
    expect(tokenClass("tag.html")).toBe("tag");
    expect(tokenClass("attribute.name.html")).toBe("attr");
    expect(tokenClass("attribute.value.html")).toBe("string");
    expect(tokenClass("identifier.ts")).toBe("plain");
    expect(tokenClass("delimiter.ts")).toBe("plain");
    expect(tokenClass("")).toBe("plain");
  });
});

describe("toSegments", () => {
  const tok = (offset: number, type: string) => ({ offset, type });

  it("splits a line at token offsets, with the class of each token", () => {
    const segs = toSegments("export const a = 1;", [[tok(0, "keyword.ts"), tok(6, "white.ts"), tok(7, "keyword.ts"), tok(12, "white.ts"), tok(13, "identifier.ts"), tok(14, "white.ts"), tok(15, "delimiter.ts"), tok(16, "white.ts"), tok(17, "number.ts"), tok(18, "delimiter.ts")]]);
    expect(segs[0]).toEqual([
      { text: "export", cls: "keyword" },
      { text: " ", cls: "plain" },
      { text: "const", cls: "keyword" },
      { text: " a = ", cls: "plain" },
      { text: "1", cls: "number" },
      { text: ";", cls: "plain" },
    ]);
  });

  it("always spells exactly the input, however the tokens fall", () => {
    const text = "line one\n\n  indented // note";
    const tokens = [[tok(0, "identifier"), tok(5, "keyword")], [], [tok(2, "identifier"), tok(11, "comment")]];
    const joined = toSegments(text, tokens).map((l) => l.map((s) => s.text).join("")).join("\n");
    expect(joined).toBe(text);
  });

  it("keeps uncovered leading text plain, merges plain neighbours, and survives missing lines and offsets past the end", () => {
    const text = "  x = 1\nsecond";
    const segs = toSegments(text, [[tok(2, "identifier"), tok(99, "number")]]);
    expect(segs[0]).toEqual([{ text: "  x = 1", cls: "plain" }]); // leading text and plain tokens merge into one segment
    expect(segs[1]).toEqual([{ text: "second", cls: "plain" }]); // no tokens for line 2: shown plain
  });

  it("treats markup in the text as plain characters, never as anything to run", () => {
    const text = '<img src=x onerror="alert(1)">';
    const joined = toSegments(text, [[tok(0, "tag.html")]]).flat().map((s) => s.text).join("");
    expect(joined).toBe(text);
  });
});

describe("languageFromFence", () => {
  const langs = [
    { id: "plaintext", aliases: ["Plain Text", "text"], extensions: [".txt"] },
    { id: "typescript", aliases: ["TypeScript", "ts"], extensions: [".ts", ".tsx"] },
    { id: "javascript", aliases: ["JavaScript", "js"], extensions: [".js"] },
    { id: "python", aliases: ["Python", "py"], extensions: [".py"] },
    { id: "shell", aliases: ["Shell", "sh"], extensions: [".sh"] },
    { id: "json", aliases: ["JSON"], extensions: [".json"] },
  ];

  it("maps common fence labels to a language", () => {
    expect(languageFromFence("ts", langs)).toBe("typescript");
    expect(languageFromFence("TypeScript", langs)).toBe("typescript");
    expect(languageFromFence("tsx", langs)).toBe("typescript");
    expect(languageFromFence("py", langs)).toBe("python");
    expect(languageFromFence("bash", langs)).toBe("shell");
    expect(languageFromFence("json", langs)).toBe("json");
  });

  it("is null for no label, an unknown label, or plain text", () => {
    expect(languageFromFence("", langs)).toBeNull();
    expect(languageFromFence("klingon", langs)).toBeNull();
    expect(languageFromFence("text", langs)).toBeNull();
    expect(languageFromFence("plaintext", langs)).toBeNull();
  });
});
