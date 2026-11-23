import { describe, expect, it } from "vitest";
import { cleanCommitMessage } from "./commitMessage";

describe("cleanCommitMessage", () => {
  it("leaves a clean message alone, body included", () => {
    expect(cleanCommitMessage("Add retry to the API client")).toBe("Add retry to the API client");
    expect(cleanCommitMessage("Fix typo\n\nThe README said recieve.")).toBe("Fix typo\n\nThe README said recieve.");
  });

  it("removes backticks, quotes and a markdown heading marker (what a small model actually returned)", () => {
    expect(cleanCommitMessage("`# [docs] Update README.md to clarify instructions`")).toBe("[docs] Update README.md to clarify instructions");
    expect(cleanCommitMessage("`Implement retry logic for API requests`")).toBe("Implement retry logic for API requests");
    expect(cleanCommitMessage('"Rename add to sum"')).toBe("Rename add to sum");
    expect(cleanCommitMessage("### Fix the build")).toBe("Fix the build");
  });

  it("unwraps a fenced block and drops a label in front", () => {
    expect(cleanCommitMessage("```\nFix the build\n\nIt broke on CI.\n```")).toBe("Fix the build\n\nIt broke on CI.");
    expect(cleanCommitMessage("```text\nFix the build\n```")).toBe("Fix the build");
    expect(cleanCommitMessage("Commit message: Fix the build")).toBe("Fix the build");
    expect(cleanCommitMessage("Here is the commit message:\n\nFix the build")).toBe("Fix the build");
    expect(cleanCommitMessage("Subject - Fix the build")).toBe("Fix the build");
  });

  it("does not eat backticks that belong to the message, or a heading-like word in the middle", () => {
    expect(cleanCommitMessage("Rename `add` to `sum` in utils")).toBe("Rename `add` to `sum` in utils");
    expect(cleanCommitMessage("Fix issue #12 in parser")).toBe("Fix issue #12 in parser");
    expect(cleanCommitMessage("Update the message handling")).toBe("Update the message handling");
  });

  it("copes with empty and whitespace-only input and Windows line endings", () => {
    expect(cleanCommitMessage("")).toBe("");
    expect(cleanCommitMessage("  \n ")).toBe("");
    expect(cleanCommitMessage("Fix it\r\n\r\nBody")).toBe("Fix it\n\nBody");
  });
});
