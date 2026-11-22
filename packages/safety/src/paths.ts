// Commands the agent runs must not reach credential stores. The OS sandbox is the hard boundary where available;
// this check is the portable first line and gives the model a clear refusal instead of a confusing OS error.

const SENSITIVE: [RegExp, string][] = [
  [/(?:^|[\s"'=\\/:])(?:~|%userprofile%|\$home|\$\{home\}|\$env:userprofile)?[\\/]*\.ssh(?:[\\/\s"']|$)/i, "SSH keys (~/.ssh)"],
  [/\.aws[\\/]|\.azure[\\/]|\.config[\\/]gcloud|\.kube[\\/]config|\.docker[\\/]config\.json/i, "cloud or container credentials"],
  [/\.gnupg\b|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.pem\b.*\bprivate\b|\.netrc\b|\.git-credentials\b/i, "private keys or stored credentials"],
  [/\bcmdkey\b|\bvaultcmd\b|credential\s*manager|\bLogin Data\b|\bCookies\b.*\bChrome\b|Mozilla[\\/]Firefox[\\/]Profiles|\blogins\.json\b/i, "the OS credential store or browser passwords"],
  [/\/etc\/(?:shadow|sudoers)\b|\breg\s+(?:save|export|query)\b.*\b(?:SAM|SECURITY|SYSTEM)\b/i, "system password databases"],
  [/\b(?:env|printenv|set)\s*(?:\||>|$)|\bGet-ChildItem\s+env:|\bdir\s+env:/i, "the full process environment (it may hold tokens)"],
];

/** Why a command is refused for touching credential locations, or null when it looks fine. */
export function sensitivePathReason(command: string): string | null {
  for (const [re, why] of SENSITIVE) if (re.test(command)) return why;
  return null;
}

const SECRET_ENV = /token|secret|passw(?:or)?d|api[_-]?key|credential|private[_-]?key|auth|session|cookie|^aws_|^azure_|^gcp_|^google_application|ssh_auth_sock|^anthropic|^openai|^github_|^gh_|^npm_config__auth|^docker_|^kube/i;

/** Environment for agent-run commands: secrets removed. (The Rust runner also remaps HOME and TEMP into the sandbox.) */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET_ENV.test(k)) out[k] = v;
  return out;
}
