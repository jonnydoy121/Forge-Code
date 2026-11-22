/** Convert a filesystem path (Windows or POSIX) to a file:// URI. */
export function pathToUri(path: string): string {
  const p = path.replace(/\\/g, "/");
  const encoded = p.split("/").map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/** Canonical form for comparing URIs from different servers (encoded colon, drive-letter case). */
export function normalizeUri(uri: string): string {
  let s = decodeURIComponent(uri);
  s = s.replace(/^file:\/\/\/([A-Za-z]):/, (_m, d: string) => `file:///${d.toLowerCase()}:`);
  return s;
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact", mjs: "javascript", cjs: "javascript",
  py: "python", json: "json", md: "markdown", rs: "rust", go: "go", html: "html", css: "css", toml: "ini", yml: "yaml", yaml: "yaml",
};

export function languageForPath(path: string): string {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGES[ext] ?? "plaintext";
}
