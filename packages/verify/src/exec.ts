export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  millis: number;
  /** set when the command ran in a sandbox */
  sandbox?: SandboxInfo;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Run confined to the workspace with no network and a scrubbed environment (agent commands). */
  sandbox?: boolean;
  /** With sandbox: also allow read-only access to tool directories on PATH so project tools run. */
  toolchainRead?: boolean;
}

export interface SandboxInfo {
  mode: "appcontainer" | "env-only" | "none";
  granted?: string[];
  warnings?: string[];
}

/** Runs a shell command. Tauri-backed in the app, child_process-backed in tests. */
export interface Exec {
  run(command: string, opts: ExecOptions): Promise<ExecResult>;
}
