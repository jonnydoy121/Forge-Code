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
