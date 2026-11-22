import { describe, expect, it } from "vitest";
import { createEditTools, createToolHost, readFileTool, type EditOutcome, type EditSink, type FsBackend } from "../src";

const nofs: FsBackend = { readFile: async () => "", readdir: async () => [] };

function setup(files: Record<string, string>, outcome: Partial<EditOutcome> = {}) {
  const proposals: { path: string; proposed: string | null; reason: string }[] = [];
  const sink: EditSink = {
    read: async (p) => files[p] ?? null,
    propose: async (path, proposed, reason) => {
      proposals.push({ path, proposed, reason });
      return { status: "pending", added: 1, removed: 1, ...outcome };
    },
  };
  const host = createToolHost({ root: "/ws", fs: nofs, tools: [readFileTool, ...createEditTools(sink)] });
  const run = (name: string, args: Record<string, unknown>, mode: "ask" | "agent" = "agent") => host.call(mode, { id: "1", name, args });
  return { run, proposals, host };
}

describe("edit tools", () => {
  it("are write-class: hidden and blocked in ask/plan, available in agent/debug", async () => {
    const { host, run, proposals } = setup({ "/ws/a.ts": "x" });
    expect(host.listTools("ask").map((t) => t.name)).toEqual(["read_file"]);
    expect(host.listTools("plan").map((t) => t.name)).toEqual(["read_file"]);
    expect(host.listTools("agent").map((t) => t.name)).toEqual(["read_file", "edit_file", "write_file", "delete_file"]);
    expect((await run("edit_file", { path: "a.ts", old_string: "x", new_string: "y" }, "ask")).ok).toBe(false);
    expect(proposals).toEqual([]);
  });

  it("edit_file replaces a unique match and passes the reason through", async () => {
    const { run, proposals } = setup({ "/ws/a.ts": "const a = 1;\nconst b = 2;\n" });
    const r = await run("edit_file", { path: "a.ts", old_string: "const b = 2;", new_string: "const b = 3;", reason: "bump b" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("pending the developer's review");
    expect(proposals).toEqual([{ path: "/ws/a.ts", proposed: "const a = 1;\nconst b = 3;\n", reason: "bump b" }]);
  });

  it("edit_file treats $ patterns in new_string literally", async () => {
    const { run, proposals } = setup({ "/ws/a.ts": "price" });
    await run("edit_file", { path: "a.ts", old_string: "price", new_string: "'$&' $1" });
    expect(proposals[0]!.proposed).toBe("'$&' $1");
  });

  it("edit_file rejects missing, ambiguous and non-matching edits with actionable errors", async () => {
    const { run, proposals } = setup({ "/ws/a.ts": "dup dup", "/ws/b.ts": "hello" });
    expect((await run("edit_file", { path: "a.ts", old_string: "dup", new_string: "x" })).output).toContain("matches 2 places");
    expect((await run("edit_file", { path: "b.ts", old_string: "nope", new_string: "x" })).output).toContain("not found");
    expect((await run("edit_file", { path: "zzz.ts", old_string: "a", new_string: "x" })).output).toContain("does not exist");
    expect(proposals).toEqual([]);
  });

  it("replace_all changes every occurrence (renames)", async () => {
    const { run, proposals } = setup({ "/ws/a.ts": "getById(1); getById(2);" });
    await run("edit_file", { path: "a.ts", old_string: "getById", new_string: "findById", replace_all: true });
    expect(proposals[0]!.proposed).toBe("findById(1); findById(2);");
  });

  it("write_file creates files and delete_file proposes null", async () => {
    const { run, proposals } = setup({ "/ws/old.ts": "bye" });
    await run("write_file", { path: "src/new.ts", content: "export {};\n" });
    await run("delete_file", { path: "old.ts" });
    expect(proposals).toEqual([
      { path: "/ws/src/new.ts", proposed: "export {};\n", reason: "" },
      { path: "/ws/old.ts", proposed: null, reason: "" },
    ]);
  });

  it("refuses path escapes, secret files and generated directories", async () => {
    const { run, proposals } = setup({});
    expect((await run("write_file", { path: "../evil.ts", content: "x" })).output).toContain("escapes workspace");
    expect((await run("write_file", { path: ".env", content: "x" })).output).toContain("secrets");
    expect((await run("write_file", { path: "node_modules/x/i.js", content: "x" })).output).toContain("ignored or generated");
    expect(proposals).toEqual([]);
  });

  it("reports applied and conflict outcomes accurately", async () => {
    const files = { "/ws/a.ts": "x" };
    expect((await setup(files, { status: "applied", checkpoint: "cp-00007" }).run("write_file", { path: "a.ts", content: "y" })).output).toContain("checkpoint cp-00007");
    expect((await setup(files, { status: "conflict" }).run("write_file", { path: "a.ts", content: "y" })).output).toContain("NOT applied");
  });
});
