import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./markdown";

describe("inline markdown", () => {
  it("finds code, bold, italic and links, and leaves other text alone", () => {
    expect(parseInline("use `foo()` and **bold** and *it* here")).toEqual([
      { type: "text", text: "use " },
      { type: "code", text: "foo()" },
      { type: "text", text: " and " },
      { type: "bold", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "italic", children: [{ type: "text", text: "it" }] },
      { type: "text", text: " here" },
    ]);
  });

  it("keeps code literal: markers inside backticks are not formatting", () => {
    expect(parseInline("`a **b** c`")).toEqual([{ type: "code", text: "a **b** c" }]);
  });

  it("does not treat arithmetic or snake_case as emphasis", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
    expect(parseInline("my_var_name and a*b")).toEqual([{ type: "text", text: "my_var_name and a*b" }]);
  });

  it("keeps unmatched markers as plain text (a reply that is still streaming)", () => {
    expect(parseInline("half `open and **bold")).toEqual([{ type: "text", text: "half `open and **bold" }]);
  });

  it("turns links into link data with the url kept separate, never an instruction to navigate", () => {
    expect(parseInline("see [the docs](https://example.com/a?b=1)")).toEqual([
      { type: "text", text: "see " },
      { type: "link", text: "the docs", url: "https://example.com/a?b=1" },
    ]);
  });

  it("passes HTML through as text (it is never inserted as markup)", () => {
    expect(parseInline("<img src=x onerror=alert(1)> <b>hi</b>")).toEqual([{ type: "text", text: "<img src=x onerror=alert(1)> <b>hi</b>" }]);
  });
});

describe("block markdown", () => {
  it("separates paragraphs, headings and lists", () => {
    const blocks = parseBlocks("# Title\n\nFirst para\nstill first\n\n- one\n- two\n\n1. a\n2. b\n");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "para", "list", "list"]);
    expect(blocks[1]).toMatchObject({ type: "para", inline: [{ type: "text", text: "First para\nstill first" }] });
    expect(blocks[2]).toMatchObject({ type: "list", ordered: false });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[3]).toMatchObject({ type: "list", ordered: true });
  });

  it("reads a fenced code block with its language, keeping its contents exactly", () => {
    const blocks = parseBlocks("Here:\n```ts\nconst a = `x`;\n  // **not bold**\n```\nDone");
    expect(blocks).toEqual([
      { type: "para", inline: [{ type: "text", text: "Here:" }] },
      { type: "code", lang: "ts", text: "const a = `x`;\n  // **not bold**", closed: true },
      { type: "para", inline: [{ type: "text", text: "Done" }] },
    ]);
  });

  it("treats an unterminated fence as code to the end, so a streaming reply renders as code right away", () => {
    const [b] = parseBlocks("```python\nprint(1)\nprint(2)");
    expect(b).toEqual({ type: "code", lang: "python", text: "print(1)\nprint(2)", closed: false });
  });

  it("a shorter fence inside a longer one does not end the block", () => {
    const blocks = parseBlocks("````md\n```js\ninner\n```\n````");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "code", lang: "md", closed: true });
  });

  it("handles empty input and Windows line endings", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("a\r\n\r\nb")).toHaveLength(2);
  });

  it("does not mistake a line starting with a dash inside a paragraph for nothing: a bullet list needs the space", () => {
    expect(parseBlocks("-not a bullet")).toMatchObject([{ type: "para" }]);
  });
});
