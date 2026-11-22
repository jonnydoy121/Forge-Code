import type { AuditLog } from "./audit";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u);

export class LocalOnlyError extends Error {
  /** A policy refusal, not a transient failure: callers must not retry it. */
  readonly retryable = false;
  constructor(public url: string) {
    super(`Blocked: local-only mode is on, so requests to ${hostOf(url)} are not allowed. Turn it off in Settings to use a hosted service.`);
    this.name = "LocalOnlyError";
  }
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/**
 * Wrap a fetch so every outbound request is logged (host only, never the body or credentials) and, in local-only
 * mode, anything that would leave this machine is refused. This is how "no code leaves the machine" is enforced and
 * verified: the audit log's network view lists every request and whether it stayed local.
 */
export function guardFetch(inner: FetchLike, opts: { localOnly: () => boolean; audit?: AuditLog; label?: string }): FetchLike {
  return async (url, init) => {
    const local = isLocalUrl(url);
    const blocked = opts.localOnly() && !local;
    opts.audit?.record({ kind: "network", name: `${init.method ?? "GET"} ${hostOf(url)}`, detail: opts.label, local, blocked });
    if (blocked) throw new LocalOnlyError(url);
    return inner(url, init);
  };
}
