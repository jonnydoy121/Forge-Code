import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThreadWorktree, mergeThread, removeThread, threadBranch, threadPath, threadSummary, type GitRun, type TextFs } from "./worktree";

const git: GitRun = async (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const fs: TextFs = {
  read: async (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  write: async (p, c) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, c)),
};
const sh = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

function repo(commit = true) {
  const root = mkdtempSync(join(tmpdir(), "forge-wt-")).replace(/[\\]/g, "/");
  sh(root, "init", "-q");
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  sh(root, "config", "core.autocrlf", "false");
  writeFileSync(`${root}/a.txt`, "one\n");
  if (commit) {
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "initial");
  }
  return root;
}

describe("thread worktrees", () => {
  it("creates an isolated checkout on its own branch and keeps it out of the main checkout's git view", async () => {
    const root = repo();
    const wt = await createThreadWorktree({ git, fs, root, id: "t2" });
    expect(wt).toEqual({ path: threadPath(root, "t2"), branch: "forge/t2" });
    expect(existsSync(`${wt.path}/a.txt`)).toBe(true);
    expect(sh(wt.path, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe("forge/t2");
    // The trap: without the exclude, `git add -A` in the main checkout would stage the nested worktree as a gitlink.
    expect(sh(root, "status", "--porcelain").stdout).not.toContain("worktrees");
    sh(root, "add", "-A");
    expect(sh(root, "diff", "--cached", "--name-only").stdout).not.toContain(".forge");
  });

  it("writes the exclude entry once, however many threads are created", async () => {
    const root = repo();
    await createThreadWorktree({ git, fs, root, id: "t2" });
    await createThreadWorktree({ git, fs, root, id: "t3" });
    const exclude = readFileSync(`${root}/.git/info/exclude`, "utf8");
    expect(exclude.split("\n").filter((l) => l === ".forge/worktrees/")).toHaveLength(1);
  });

  it("explains itself when there is no commit to branch from", async () => {
    await expect(createThreadWorktree({ git, fs, root: repo(false), id: "t2" })).rejects.toThrow("at least one commit");
  });

  it("two threads edit the same file at the same time without touching each other or main", async () => {
    const root = repo();
    const a = await createThreadWorktree({ git, fs, root, id: "t2" });
    const b = await createThreadWorktree({ git, fs, root, id: "t3" });
    writeFileSync(`${a.path}/a.txt`, "from thread two\n");
    writeFileSync(`${b.path}/a.txt`, "from thread three\n");
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("one\n");
    expect(readFileSync(`${a.path}/a.txt`, "utf8")).toBe("from thread two\n");
    expect(readFileSync(`${b.path}/a.txt`, "utf8")).toBe("from thread three\n");
  });

  it("summarises the thread's changes, including edits it has not committed yet", async () => {
    const root = repo();
    const wt = await createThreadWorktree({ git, fs, root, id: "t2" });
    writeFileSync(`${wt.path}/a.txt`, "two\n");
    writeFileSync(`${wt.path}/new.txt`, "added\n");
    const stat = await threadSummary(git, root, "t2", wt.path);
    expect(stat).toContain("a.txt");
    expect(stat).toContain("new.txt");
  });

  it("merges a finished thread (uncommitted work included) into main, then removes its worktree and branch", async () => {
    const root = repo();
    const wt = await createThreadWorktree({ git, fs, root, id: "t2" });
    writeFileSync(`${wt.path}/a.txt`, "two\n");
    writeFileSync(`${wt.path}/new.txt`, "added\n");
    const r = await mergeThread({ git, root, id: "t2", name: "Thread 2" });
    expect(r.ok, r.message).toBe(true);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("two\n");
    expect(existsSync(`${root}/new.txt`)).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(root, "branch", "--list", "forge/t2").stdout.trim()).toBe("");
    expect(sh(root, "log", "--oneline", "-n", "1").stdout).toContain("Merge Forge-Code thread: Thread 2");
  });

  it("a thread that changed nothing merges as a no-op and is cleaned up", async () => {
    const root = repo();
    await createThreadWorktree({ git, fs, root, id: "t2" });
    const r = await mergeThread({ git, root, id: "t2", name: "Thread 2" });
    expect(r.ok, r.message).toBe(true);
    expect(existsSync(threadPath(root, "t2"))).toBe(false);
  });

  it("a conflicting merge is aborted: main is unchanged and the thread's work is kept", async () => {
    const root = repo();
    const wt = await createThreadWorktree({ git, fs, root, id: "t2" });
    writeFileSync(`${wt.path}/a.txt`, "thread\n");
    writeFileSync(`${root}/a.txt`, "main\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "main change");
    const r = await mergeThread({ git, root, id: "t2", name: "Thread 2" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(threadBranch("t2"));
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("main\n");
    expect(sh(root, "status", "--porcelain").stdout.trim()).toBe("");
    expect(existsSync(wt.path)).toBe(true); // nothing lost
    expect(sh(root, "branch", "--list", "forge/t2").stdout.trim()).not.toBe("");
  });

  it("discarding removes the worktree and branch without merging", async () => {
    const root = repo();
    const wt = await createThreadWorktree({ git, fs, root, id: "t2" });
    writeFileSync(`${wt.path}/a.txt`, "throw away\n");
    expect(await removeThread(git, root, "t2")).toBeNull();
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("one\n");
    expect(sh(root, "branch", "--list", "forge/t2").stdout.trim()).toBe("");
  });

  it("reports why removal failed instead of pretending it worked", async () => {
    const root = repo();
    const failing: GitRun = async (cwd, args) => (args[0] === "worktree" && args[1] === "remove" ? { ok: false, stdout: "", stderr: "error: failed to delete: Permission denied\nmore detail" } : git(cwd, args));
    await createThreadWorktree({ git, fs, root, id: "t2" });
    const problem = await removeThread(failing, root, "t2");
    expect(problem).toContain("could not remove the thread's checkout");
    expect(problem).toContain("Permission denied");
    expect(problem).not.toContain("more detail"); // first line only
    expect(sh(root, "branch", "--list", "forge/t2").stdout.trim()).not.toBe(""); // the branch is kept while the checkout is still there
  });
});
