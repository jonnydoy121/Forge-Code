// Using your Claude subscription (Pro, Max) without an API key: Forge drives the official Claude Code client over ACP, and Claude Code
// signs in with your Claude account. Forge never sees or stores that login; it only asks Claude Code whether it is signed in.
import type { AcpAgentConfig } from "@forge/acp";

/** The built-in external agent. A `claude` entry in .forge/acp.json takes its place. */
export const CLAUDE_AGENT: AcpAgentConfig = { name: "claude", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], env: {} };

export type ClaudePlan =
  | { state: "signed-in"; method: string; subscription: boolean }
  | { state: "signed-out" }
  | { state: "missing" }
  | { state: "unknown"; detail: string };

/** What `claude auth status` printed, as a status. A subscription is a claude.ai login; an API key or a cloud provider is not one. */
export function parseAuthStatus(code: number | null, stdout: string, stderr: string): ClaudePlan {
  const out = stdout.trim();
  if (code !== 0 && !out.startsWith("{")) {
    const err = `${stderr}${out}`.toLowerCase();
    if (/not recognized|not found|enoent|no such file/.test(err) || code === 127) return { state: "missing" };
    return { state: "unknown", detail: (stderr || out).trim().slice(0, 160) || `exit code ${code}` };
  }
  try {
    const j = JSON.parse(out) as { loggedIn?: unknown; authMethod?: unknown };
    if (j.loggedIn !== true) return { state: "signed-out" };
    const method = typeof j.authMethod === "string" ? j.authMethod : "unknown";
    return { state: "signed-in", method, subscription: method === "claude.ai" };
  } catch {
    return { state: "unknown", detail: "could not read the answer of `claude auth status`" };
  }
}

/** Runs a command and reports how it ended: the part of the app this needs, so it can be tested without a shell. */
export type RunCommand = (command: string) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;

export async function detectClaudePlan(run: RunCommand): Promise<ClaudePlan> {
  try {
    const r = await run("claude auth status");
    if (r.timedOut) return { state: "unknown", detail: "`claude auth status` did not answer in time" };
    return parseAuthStatus(r.code, r.stdout, r.stderr);
  } catch (e) {
    return { state: "unknown", detail: e instanceof Error ? e.message : String(e) };
  }
}

const CACHE_KEY = "forge.claude-plan.v1";
const CACHE_MS = 10 * 60_000;
type Store = Pick<Storage, "getItem" | "setItem">;

/** The last definite answer if it is recent. Remembered so the mode list is right from the first paint instead of changing a moment after it. */
export function readCachedPlan(store: Store | null, now = Date.now()): ClaudePlan | null {
  try {
    const raw = store?.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, plan } = JSON.parse(raw) as { at?: number; plan?: ClaudePlan };
    return plan && typeof at === "number" && now - at < CACHE_MS && now >= at ? plan : null;
  } catch {
    return null;
  }
}

let inflight: Promise<ClaudePlan> | null = null;

/**
 * The plan status, from the cache when it is fresh (unless `force`), else by asking Claude Code. Many panels may ask at once (one per
 * thread): they share one question. Only definite answers are remembered; "unknown" is asked again next time.
 */
export function claudePlanCached(run: RunCommand, opts: { force?: boolean; store?: Store | null; now?: number } = {}): Promise<ClaudePlan> {
  const store = opts.store === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : opts.store;
  if (!opts.force) {
    const hit = readCachedPlan(store, opts.now);
    if (hit) return Promise.resolve(hit);
    if (inflight) return inflight;
  }
  const asked = detectClaudePlan(run).then((plan) => {
    if (plan.state !== "unknown") {
      try {
        store?.setItem(CACHE_KEY, JSON.stringify({ at: opts.now ?? Date.now(), plan }));
      } catch {
        /* storage unavailable: just not remembered */
      }
    }
    return plan;
  });
  inflight = asked;
  const clear = () => {
    if (inflight === asked) inflight = null;
  };
  void asked.then(clear, clear);
  return asked;
}

/** One line for the settings screen. */
export function describeClaudePlan(p: ClaudePlan | null, localOnly: boolean): string {
  if (localOnly) return "Local-only mode is on, so Claude (which runs on Anthropic's servers) is hidden.";
  if (!p) return "Checking whether Claude Code is signed in…";
  switch (p.state) {
    case "signed-in":
      return p.subscription ? "Signed in with your Claude plan. Choose \"Claude plan\" in the mode list to use it." : `Claude Code is signed in with ${p.method}, which is not a Claude subscription: it will bill that account. Choose "Claude plan" in the mode list to use it.`;
    case "signed-out":
      return "Claude Code is installed but not signed in. Open a terminal, run `claude`, and sign in with your Claude account (the /login command), then press Check again.";
    case "missing":
      return "Claude Code is not installed. Install it from claude.com/product/claude-code, sign in once with your Claude account, then press Check again.";
    case "unknown":
      return `Could not tell whether Claude Code is signed in (${p.detail}).`;
  }
}
