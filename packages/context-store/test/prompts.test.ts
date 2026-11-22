import { describe, expect, it } from "vitest";
import { expandPrompt, loadPrompts, matchPrompts, parsePromptFile, type PromptFs } from "../src/prompts";

const review = { name: "review", description: "Review a file", body: "Review $ARGUMENTS for bugs. Be concise." };
const plain = { name: "explain", description: "Explain", body: "Explain the selected code step by step." };

describe("saved prompts", () => {
  it("reads the description from front matter, else the first line", () => {
    expect(parsePromptFile("review.md", "---\ndescription: Review a file\n---\nReview $ARGUMENTS")).toEqual({ name: "review", description: "Review a file", body: "Review $ARGUMENTS" });
    expect(parsePromptFile("fix.md", "# Fix the failing test\nRun it and fix it.")!.description).toBe("Fix the failing test");
  });

  it("skips empty files and names that are not valid commands", () => {
    expect(parsePromptFile("empty.md", "---\ndescription: x\n---\n   ")).toBeNull();
    expect(parsePromptFile("has space.md", "body")).toBeNull();
    expect(parsePromptFile("../escape.md", "body")).toBeNull();
  });

  it("loads from a folder, ignores non-markdown files and tolerates a missing folder", async () => {
    const files: Record<string, string> = { "/p/b.md": "Second", "/p/a.md": "First", "/p/notes.txt": "ignored" };
    const fs: PromptFs = {
      read: async (p) => files[p] ?? null,
      list: async (d) => {
        if (d !== "/p") throw new Error("no such folder");
        return Object.keys(files).map((k) => k.slice(3));
      },
    };
    expect((await loadPrompts(fs, "/p")).map((p) => p.name)).toEqual(["a", "b"]);
    expect(await loadPrompts(fs, "/missing")).toEqual([]);
  });

  it("expands $ARGUMENTS, appends arguments when the body has no placeholder, and leaves unknown commands alone", () => {
    expect(expandPrompt("/review src/a.ts", [review])).toEqual({ name: "review", prompt: "Review src/a.ts for bugs. Be concise." });
    expect(expandPrompt("/REVIEW  src/a.ts ", [review])!.prompt).toContain("Review src/a.ts for");
    expect(expandPrompt("/explain focus on the loop", [plain])!.prompt).toBe("Explain the selected code step by step.\n\nfocus on the loop");
    expect(expandPrompt("/explain", [plain])!.prompt).toBe("Explain the selected code step by step.");
    expect(expandPrompt("/nope x", [review])).toBeNull();
    expect(expandPrompt("review src/a.ts", [review])).toBeNull();
    expect(expandPrompt("/usr/bin/env is a path, not a command", [review])).toBeNull();
  });

  it("never interprets replacement patterns inside the arguments", () => {
    expect(expandPrompt("/review $& and $1", [review])!.prompt).toBe("Review $& and $1 for bugs. Be concise.");
  });

  it("suggests commands while the name is being typed", () => {
    expect(matchPrompts("/", [review, plain]).map((p) => p.name)).toEqual(["review", "explain"]);
    expect(matchPrompts("/re", [review, plain]).map((p) => p.name)).toEqual(["review"]);
    expect(matchPrompts("/review src", [review])).toEqual([]);
    expect(matchPrompts("hello", [review])).toEqual([]);
  });
});
