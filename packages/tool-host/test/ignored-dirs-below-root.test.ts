import { describe, expect, it } from "vitest";
import { inIgnoredDirBelow } from "@forge/protocol";
import { createEditTools, createToolHost, READ_TOOLS, type EditSink, type FsBackend } from "../src";

const fs: FsBackend = { readFile: async () => "", readdir: async () => [] };

describe("ignored directories are judged below the workspace root only", () => {
  it("ignores folders above the root, such as a worktree under .forge/worktrees or a project living in build/", () => {
    expect(inIgnoredDirBelow("/repo/.forge/worktrees/t2", "/repo/.forge/worktrees/t2/src/a.ts")).toBe(false);
    expect(inIgnoredDirBelow("/home/u/build/proj", "/home/u/build/proj/src/a.ts")).toBe(false);
    expect(inIgnoredDirBelow("C:\\work\\target\\app", "C:/work/target/app/src/a.ts")).toBe(false);
  });

  it("still flags generated and internal directories beneath the root", () => {
    expect(inIgnoredDirBelow("/repo", "/repo/node_modules/x/index.js")).toBe(true);
    expect(inIgnoredDirBelow("/repo", "/repo/.git/config")).toBe(true);
    expect(inIgnoredDirBelow("/repo", "/repo/packages/a/dist/out.js")).toBe(true);
    expect(inIgnoredDirBelow("/repo/.forge/worktrees/t2", "/repo/.forge/worktrees/t2/node_modules/x.js")).toBe(true);
    expect(inIgnoredDirBelow("/repo/", "/repo/.forge/pending/a.json")).toBe(true);
  });

  const proposals: string[] = [];
  const sink: EditSink = {
    read: async () => "const a = 1;",
    propose: async (path) => (proposals.push(path), { status: "applied", added: 1, removed: 1 }),
  };
  const host = (root: string) => createToolHost({ root, fs, tools: [...READ_TOOLS, ...createEditTools(sink)] });
  const edit = (root: string, path: string) => host(root).call("agent", { id: "1", name: "edit_file", args: { path, old_string: "a = 1", new_string: "a = 2", reason: "r" } });

  it("lets the edit tool work in a checkout that lives under .forge/worktrees", async () => {
    const r = await edit("/repo/.forge/worktrees/t2", "src/a.ts");
    expect(r.ok, r.output).toBe(true);
    expect(proposals.at(-1)).toBe("/repo/.forge/worktrees/t2/src/a.ts");
  });

  it("still refuses to edit generated directories inside it", async () => {
    const before = proposals.length;
    const r = await edit("/repo/.forge/worktrees/t2", "node_modules/pkg/index.js");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("ignored or generated");
    expect(proposals.length).toBe(before);
  });
});
