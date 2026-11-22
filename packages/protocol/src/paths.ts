// Path, ignore and secret helpers shared by the tool host, indexer and runtime. Pure functions, no I/O.

const norm = (p: string) => p.replace(/\\/g, "/");

/** Resolve `p` against `root` and ensure it stays inside. Returns a forward-slash absolute path. Throws otherwise. */
export function resolveInRoot(root: string, p: string): string {
  const r = norm(root).replace(/\/+$/, "");
  const isAbs = /^([A-Za-z]:)?\//.test(norm(p));
  const parts = (isAbs ? norm(p) : `${r}/${norm(p)}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const resolved = (r.startsWith("/") ? "/" : "") + out.join("/");
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!(same(resolved, r) || resolved.toLowerCase().startsWith(r.toLowerCase() + "/"))) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return resolved;
}

export const relativeTo = (root: string, abs: string) => norm(abs).slice(norm(root).replace(/\/+$/, "").length + 1);

const IGNORED_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__", ".forge"]);
export const isIgnoredDir = (name: string) => IGNORED_DIRS.has(name);

const SECRET_NAMES = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^credentials/i, /^\.npmrc$/i, /^\.netrc$/i];
/** Files whose contents must never be indexed or sent to a model. */
export function isSecretPath(path: string): boolean {
  const name = norm(path).split("/").pop() ?? "";
  if (/\.env\.example$|\.env\.sample$/i.test(name)) return false;
  return SECRET_NAMES.some((re) => re.test(name));
}

/** Convert a glob (`*`, `**`, `?`) to a RegExp matching forward-slash relative paths. A bare pattern like `*.ts` matches at any depth. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED API KEY]"],
  [/\bsk-[A-Za-z0-9]{32,}/g, "[REDACTED API KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[REDACTED GITHUB TOKEN]"],
  [/\b(api[_-]?key|secret|token|password)(\s*[:=]\s*)(["'])[^"'\n]{8,}\3/gi, "$1$2$3[REDACTED]$3"],
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(([re]) => new RegExp(re.source, re.flags.replace("g", "")).test(text));
}

/** Redact detected secrets from text before it goes to a model or a log. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), text);
}
