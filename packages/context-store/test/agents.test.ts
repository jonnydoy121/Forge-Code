import { describe, expect, it } from "vitest";
import { agentsIndex, loadAgents, type AgentFs } from "../src";

function memFs(files: Record<string, string>): AgentFs {
  return {
    read: async (p) => files[p] ?? null,
    list: async (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set(Object.keys(files).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split("/")[0]!));
      if (names.size === 0) throw new Error("ENOENT");
      return [...names];
    },
  };
}

describe("loadAgents", () => {
  it("reads a specialist's description, tools, tier and instructions from its markdown file", async () => {
    const fs = memFs({
      "/r/.forge/agents/security-reviewer.md": "---\ndescription: Reviews code for security problems\ntools: [read_file, grep, find_files]\ntier: architect\n---\nYou are a security reviewer.\nReport file and line.\n",
    });
    expect(await loadAgents(fs, "/r/.forge/agents")).toEqual([
      { name: "security-reviewer", description: "Reviews code for security problems", tools: ["read_file", "grep", "find_files"], tier: "architect", instructions: "You are a security reviewer.\nReport file and line.", source: "project", problems: [] },
    ]);
  });

  it("accepts a dash list of tools and defaults everything that is left out", async () => {
    const fs = memFs({ "/a/doc.md": "---\ndescription: Writes docs\ntools:\n  - read_file\n  - ls\n---\nWrite clear docs.", "/a/plain.md": "# Explorer\nFind things." });
    const [doc, plain] = await loadAgents(fs, "/a");
    expect(doc).toMatchObject({ name: "doc", tools: ["read_file", "ls"], tier: null });
    expect(plain).toMatchObject({ name: "plain", tools: null, tier: null, description: "Explorer" }); // the first line stands in for a missing description
  });

  it("ignores an unknown tier but still loads the specialist, and says why", async () => {
    const fs = memFs({ "/a/odd.md": "---\ndescription: x\ntier: genius\n---\nDo it." });
    const [odd] = await loadAgents(fs, "/a");
    expect(odd!.tier).toBeNull();
    expect(odd!.problems[0]).toContain("genius");
  });

  it("skips files that are not specialists: other extensions, bad names, no instructions", async () => {
    const fs = memFs({ "/a/notes.txt": "x", "/a/bad name.md": "Instructions", "/a/.hidden.md": "Instructions", "/a/empty.md": "---\ndescription: nothing\n---\n   ", "/a/ok.md": "Instructions" });
    expect((await loadAgents(fs, "/a")).map((a) => a.name)).toEqual(["ok"]);
  });

  it("a project specialist overrides a user one of the same name; both are listed otherwise, sorted", async () => {
    const fs = memFs({ "/p/review.md": "Project review rules.", "/u/review.md": "User review rules.", "/u/alpha.md": "Alpha." });
    const agents = await loadAgents(fs, "/p", "/u");
    expect(agents.map((a) => `${a.name}:${a.source}`)).toEqual(["alpha:user", "review:project"]);
    expect(agents[1]!.instructions).toBe("Project review rules.");
  });

  it("is empty when there is no agents folder", async () => {
    expect(await loadAgents(memFs({}), "/nowhere", "/also-nowhere")).toEqual([]);
  });

  it("builds a one-line-per-specialist index", () => {
    expect(agentsIndex([{ name: "a", description: "does a" }, { name: "b", description: "does b" }])).toBe("- a: does a\n- b: does b");
  });
});
