// Isolated agent threads: each gets its own git worktree on its own branch (forge/<id>), so parallel threads cannot
// collide on files. The developer merges a finished thread back (or discards it); nothing is merged automatically.

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type GitRun = (cwd: string, args: string[]) => Promise<GitResult>;
export interface TextFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export const threadBranch = (id: string) => `forge/${id}`;
export const threadPath = (root: string, id: string) => `${root.replace(/[\\]/g, "/").replace(/\/$/, "")}/.forge/worktrees/${id}`;
const EXCLUDE_LINE = ".forge/worktrees/";

const fail = (what: string, r: GitResult) => new Error(`${what}: ${(r.stderr || r.stdout).trim() || "git failed"}`);

/**
 * A repository nested inside the workspace would be picked up by `git add -A` as an embedded repository. The local
 * exclude file (never committed) keeps worktrees out of the main checkout's view.
 */
async function ensureExcluded(git: GitRun, fs: TextFs, root: string) {
  const where = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (!where.ok) throw fail("could not locate the git exclude file", where);
  const rel = where.stdout.trim();
  const file = /^([A-Za-z]:)?[\\/]/.test(rel) ? rel.replace(/[\\]/g, "/") : `${root.replace(/[\\]/g, "/")}/${rel}`;
  const current = (await fs.read(file)) ?? "";
  if (current.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
  await fs.write(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
}

export async function createThreadWorktree(d: { git: GitRun; fs: TextFs; root: string; id: string }): Promise<{ path: string; branch: string }> {
  const head = await d.git(d.root, ["rev-parse", "HEAD"]);
  if (!head.ok) throw new Error("Isolated threads need a git repository with at least one commit.");
  await ensureExcluded(d.git, d.fs, d.root);
  const path = threadPath(d.root, d.id);
  const branch = threadBranch(d.id);
  const r = await d.git(d.root, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (!r.ok) throw fail("could not create the worktree", r);
  return { path, branch };
}

/** `git diff --stat` of what the thread changed relative to where it started (committed work only). */
export async function threadSummary(git: GitRun, root: string, id: string, worktree: string): Promise<string> {
  await commitThreadWork(git, worktree, `Forge-Code thread ${id}`); // include uncommitted edits
  const r = await git(root, ["diff", "--stat", `HEAD...${threadBranch(id)}`]);
  return r.ok ? r.stdout.trim() : "";
}

/** Commit whatever the thread has changed in its worktree. No changes is fine. */
export async function commitThreadWork(git: GitRun, worktree: string, message: string): Promise<void> {
  const status = await git(worktree, ["status", "--porcelain"]);
  if (!status.ok) throw fail("could not read the thread's changes", status);
  if (!status.stdout.trim()) return;
  const add = await git(worktree, ["add", "-A"]);
  if (!add.ok) throw fail("could not stage the thread's changes", add);
  const commit = await git(worktree, ["commit", "-m", message]);
  if (!commit.ok) throw fail("could not commit the thread's changes", commit);
}

/** Remove the thread's checkout and branch. Returns null when both are gone, otherwise why not (e.g. a process still has the folder open). */
export async function removeThread(git: GitRun, root: string, id: string): Promise<string | null> {
  const wt = await git(root, ["worktree", "remove", "--force", threadPath(root, id)]);
  await git(root, ["worktree", "prune"]);
  if (!wt.ok) return `could not remove the thread's checkout (${firstLine(wt)})`;
  const br = await git(root, ["branch", "-D", threadBranch(id)]);
  return br.ok ? null : `could not delete branch ${threadBranch(id)} (${firstLine(br)})`;
}

const firstLine = (r: GitResult) => (r.stderr || r.stdout).trim().split(/\r?\n/)[0] || "git failed";

export type MergeResult = { ok: true; message: string } | { ok: false; message: string };

/** Commit the thread's work, merge its branch into the current branch, then remove the worktree. A conflict aborts cleanly. */
export async function mergeThread(d: { git: GitRun; root: string; id: string; name: string }): Promise<MergeResult> {
  const worktree = threadPath(d.root, d.id);
  try {
    await commitThreadWork(d.git, worktree, `Forge-Code thread: ${d.name}`);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const merged = await d.git(d.root, ["merge", "--no-ff", "-m", `Merge Forge-Code thread: ${d.name}`, threadBranch(d.id)]);
  if (!merged.ok) {
    await d.git(d.root, ["merge", "--abort"]); // leave the main checkout exactly as it was
    const why = (merged.stderr || merged.stdout).trim().split("\n").slice(0, 4).join(" ");
    return { ok: false, message: `Could not merge cleanly (${why}). Nothing was changed; the thread's work is still on branch ${threadBranch(d.id)}.` };
  }
  const leftover = await removeThread(d.git, d.root, d.id);
  return { ok: true, message: `Merged "${d.name}" into the current branch.${leftover ? ` Cleanup is incomplete: ${leftover}.` : ""}` };
}
