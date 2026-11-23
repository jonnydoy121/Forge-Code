import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const fsApi = {
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, contents: string) => invoke<void>("write_file", { path, contents }),
  initialWorkspace: () => invoke<string | null>("initial_workspace"),
};

export const ptyApi = {
  spawn: (cwd: string | null, cols: number, rows: number) => invoke<number>("pty_spawn", { cwd, cols, rows }),
  write: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: number) => invoke<void>("pty_kill", { id }),
  onData: (cb: (id: number, data: string) => void): Promise<UnlistenFn> =>
    listen<{ id: number; data: string }>("pty-data", (e) => cb(e.payload.id, e.payload.data)),
};

export const lspApi = {
  start: (language: string, root: string) => invoke<number>("lsp_start", { language, root }),
  send: (id: number, msg: string) => invoke<void>("lsp_send", { id, msg }),
  stop: (id: number) => invoke<void>("lsp_stop", { id }),
  onMessage: (cb: (id: number, msg: string) => void): Promise<UnlistenFn> =>
    listen<{ id: number; msg: string }>("lsp-msg", (e) => cb(e.payload.id, e.payload.msg)),
};

import type { IndexBackend } from "@forge/indexer";

export interface IndexStatus {
  indexed_files: number;
  walked_files: number;
  symbols: number;
  chunks: number;
  embed_calls: number;
  building: boolean;
  merkle_root: string;
}

export const indexApi = {
  start: (root: string, embedModel?: string, embedUrl?: string) => invoke<string>("index_start", { root, embedModel: embedModel || null, embedUrl: embedUrl || null }),
  status: () => invoke<IndexStatus>("index_status"),
  onProgress: (cb: (p: { phase: string; done: number; total: number }) => void): Promise<UnlistenFn> => listen<{ phase: string; done: number; total: number }>("index-progress", (e) => cb(e.payload)),
  onBuilt: (cb: () => void): Promise<UnlistenFn> => listen("index-built", () => cb()),
  onUpdated: (cb: (files: string[]) => void): Promise<UnlistenFn> => listen<string[]>("index-updated", (e) => cb(e.payload)),
};

export const indexBackend: IndexBackend = {
  grep: (pattern, glob, max) => invoke("index_grep", { pattern, glob: glob ?? null, max: max ?? null }),
  findFiles: (pattern, max) => invoke("index_find_files", { pattern, max: max ?? null }),
  symbol: (name) => invoke("index_symbol", { name }),
  references: (symbol) => invoke("index_references", { symbol }),
  repoMap: (focusFiles, tokenBudget) => invoke("index_repo_map", { focusFiles, tokenBudget }),
  semantic: (query, k) => invoke("index_semantic", { query, k }),
  cone: (path) => invoke("index_cone", { path }),
};
