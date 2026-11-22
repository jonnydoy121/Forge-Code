import { redactSecrets } from "@forge/protocol";

export type AuditKind = "model" | "tool" | "command" | "file" | "permission" | "network" | "hook" | "injection" | "sandbox" | "external";

export interface AuditEntry {
  at: number;
  kind: AuditKind;
  name: string;
  detail?: string;
  /** network entries: the request stayed on this machine */
  local?: boolean;
  /** the action was refused (local-only mode, deny list, sandbox) */
  blocked?: boolean;
}

export interface AuditFs {
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string | null>;
}

/**
 * Per-session audit log of every tool call, command, file write and model request. Secrets are redacted before an
 * entry is stored, so the log itself never holds them. Persisted as JSON lines the developer can read.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners: ((e: AuditEntry) => void)[] = [];

  constructor(
    private fs: AuditFs | null,
    private path: string,
    private now: () => number = Date.now,
  ) {}

  onEntry(f: (e: AuditEntry) => void) {
    this.listeners.push(f);
  }

  record(e: Omit<AuditEntry, "at"> & { at?: number }): AuditEntry {
    const entry: AuditEntry = { ...e, at: e.at ?? this.now(), name: redactSecrets(e.name), detail: e.detail === undefined ? undefined : redactSecrets(e.detail).slice(0, 2000) };
    this.entries.push(entry);
    for (const l of this.listeners) l(entry);
    this.schedule();
    return entry;
  }

  /** Load a previous session's entries, e.g. after a restart. */
  async load() {
    const text = await this.fs?.read(this.path);
    if (!text) return;
    const prior: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      try {
        if (line.trim()) prior.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip a corrupt line */
      }
    }
    this.entries = [...prior, ...this.entries];
  }

  list(filter?: { kind?: AuditKind; blocked?: boolean }): AuditEntry[] {
    return this.entries.filter((e) => (!filter?.kind || e.kind === filter.kind) && (filter?.blocked === undefined || !!e.blocked === filter.blocked));
  }

  /**
   * Outbound requests, split into local and remote: the "network log". Only entries written by the guarded fetch
   * count (what actually went, or was refused, at the network layer); "model" entries just say which model was used.
   */
  network() {
    const net = this.entries.filter((e) => e.kind === "network");
    return { all: net, remote: net.filter((e) => e.local === false && !e.blocked), blocked: net.filter((e) => e.blocked) };
  }

  private schedule() {
    if (!this.fs || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 250);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.fs) await this.fs.write(this.path, this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}
