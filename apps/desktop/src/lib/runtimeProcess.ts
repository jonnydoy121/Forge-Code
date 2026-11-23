// One `forge-runtime` process serves every agent thread. It is started the first time a thread needs it and released when
// the last thread closes, so three threads cost one process (about 33 MB), not three.

import { MuxClient } from "@forge/agent-runtime/src/stdio";
import type { Port } from "@forge/agent-runtime/src/remote";
import { invoke } from "@tauri-apps/api/core";
import { launchLineProcess } from "./workspace";

interface Proc {
  mux: MuxClient;
}

let current: Proc | null = null;
let starting: Promise<Proc> | null = null;
let counter = 0;

async function launch(exe: string): Promise<Proc> {
  // No working directory on purpose: an isolated thread's worktree must never be some process's cwd (Windows cannot delete
  // a folder that is in use), and the runtime does not need one (its tools run in the host).
  const t = await launchLineProcess(exe, [], undefined, {});
  const mux = new MuxClient(
    (line) => t.send(line),
    (on) => t.onLine(on),
  );
  const proc: Proc = { mux };
  const forget = () => {
    if (current === proc) current = null; // a newer process may already have replaced this one
  };
  // The process died: every open thread is told, so pending runs fail instead of hanging.
  t.onClose?.(() => {
    forget();
    mux.disconnected();
  });
  // The last thread closed: release the process (the next thread starts a fresh one).
  mux.onEmpty = () => {
    forget();
    t.close();
  };
  current = proc;
  return proc;
}

let exe: Promise<string | null> | null = null;

/** Where the bundled agent runtime lives, or null when this build has none (a Web Worker is used instead). */
export const sidecarPath = () => (exe ??= invoke<string | null>("runtime_sidecar_path").catch(() => null));

/**
 * Start the shared process before the first message needs it: launching it costs from tens of milliseconds to a few hundred
 * the very first time after an install, which is otherwise added to the first reply. Called when the user focuses the agent
 * input, so it runs while they type. Released again if nothing uses it within a minute (an idle process holds about 33 MB).
 */
export function prewarmRuntime(): void {
  if (current || starting) return;
  void sidecarPath().then((path) => {
    if (!path || current || starting) return;
    starting = launch(path).finally(() => (starting = null));
    starting
      .then((proc) => setTimeout(() => proc.mux.size === 0 && proc.mux.onEmpty?.(), 60_000))
      .catch(() => {}); // a failed pre-warm is harmless: the first message starts it (or falls back to a worker) as before
  });
}

/** A port for a new agent thread, on the shared runtime process (started now if it is not running). */
export async function openRuntimePort(exe: string): Promise<Port> {
  if (!current) starting ??= launch(exe).finally(() => (starting = null));
  const proc = current ?? (await starting!);
  return proc.mux.open(`s${++counter}`);
}
