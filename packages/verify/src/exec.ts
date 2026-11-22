export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  millis: number;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

/** Runs a shell command. Tauri-backed in the app, child_process-backed in tests. */
export interface Exec {
  run(command: string, opts: ExecOptions): Promise<ExecResult>;
}
