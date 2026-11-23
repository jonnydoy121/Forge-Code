// One `forge-runtime` process serves every agent thread. It is started the first time a thread needs it and released when
// the last thread closes, so three threads cost one process (about 33 MB), not three.

import { MuxClient } from "@forge/agent-runtime/src/stdio";
import type { Port } from "@forge/agent-runtime/src/remote";
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

/** A port for a new agent thread, on the shared runtime process (started now if it is not running). */
export async function openRuntimePort(exe: string): Promise<Port> {
  if (!current) starting ??= launch(exe).finally(() => (starting = null));
  const proc = current ?? (await starting!);
  return proc.mux.open(`s${++counter}`);
}
