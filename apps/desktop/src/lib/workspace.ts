import { FileCheckpointStore, type CheckpointFs } from "@forge/checkpoints";
import { PendingChanges, type ReviewMode } from "@forge/review";
import { createEditTools, type EditSink, type FsBackend, type RegisteredTool } from "@forge/tool-host";
import type { Runtime } from "@forge/agent-runtime";
import { invoke } from "@tauri-apps/api/core";
import { fsApi } from "./ipc";

export const norm = (p: string) => p.split("\\").join("/");

/** Workspace file access with "missing file" as null, over Tauri IPC. */
export const diskFs: CheckpointFs = {
  read: (path) => invoke<string | null>("read_file_opt", { path }),
  write: fsApi.writeFile,
  remove: (path) => invoke<void>("remove_file", { path }),
  list: (path) => invoke<string[]>("list_names", { path }),
};

export interface GitResult { ok: boolean; stdout: string; stderr: string }
export const git = (root: string, args: string[]) => invoke<GitResult>("git_run", { root, args });

export interface WorkspaceServices {
  root: string;
  sessionId: string;
  pending: PendingChanges;
  checkpoints: FileCheckpointStore;
  /** Reads see pending proposals layered over disk. */
  overlay(base: FsBackend): FsBackend;
  editTools: RegisteredTool[];
  setRuntime(rt: Runtime | null): void;
}

const SESSION_KEY = "forge.session.v1";

/** One session id per workspace, remembered so checkpoints survive restarts. */
function sessionIdFor(root: string): string {
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}") as Record<string, string>;
    if (!all[root]) {
      all[root] = `s-${Date.now().toString(36)}`;
      localStorage.setItem(SESSION_KEY, JSON.stringify(all));
    }
    return all[root]!;
  } catch {
    return `s-${Date.now().toString(36)}`;
  }
}

export function createWorkspaceServices(opts: {
  root: string;
  mode: () => ReviewMode;
  planFiles?: () => string[] | null;
  onChange: () => void;
}): WorkspaceServices {
  const root = norm(opts.root).replace(/\/+$/, "");
  const sessionId = sessionIdFor(root);
  const checkpoints = new FileCheckpointStore({ fs: diskFs, dir: `${root}/.forge/checkpoints/${sessionId}` });
  let runtime: Runtime | null = null;
  const pending = new PendingChanges({
    fs: diskFs,
    checkpoints,
    mode: opts.mode,
    planFiles: opts.planFiles,
    historyLength: () => runtime?.history.length ?? 0,
    onChange: opts.onChange,
  });
  const sink: EditSink = {
    read: async (p) => {
      const e = pending.effective(p);
      return e !== undefined ? e : diskFs.read(p);
    },
    propose: async (path, proposed, reason) => {
      const o = await pending.propose(path, proposed, reason);
      return { status: o.status, added: o.stats.added, removed: o.stats.removed, checkpoint: o.checkpoint };
    },
  };
  return {
    root,
    sessionId,
    pending,
    checkpoints,
    overlay: (base) => ({
      ...base,
      readFile: async (p) => {
        const e = pending.effective(norm(p));
        if (e === null) throw new Error("ENOENT: file is pending deletion");
        return e !== undefined ? e : base.readFile(p);
      },
    }),
    editTools: createEditTools(sink),
    setRuntime: (rt) => {
      runtime = rt;
    },
  };
}
