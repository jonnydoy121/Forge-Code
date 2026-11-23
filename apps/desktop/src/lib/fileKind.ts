// What kind of file or folder a name is, for the explorer's icons. The kind (not only the colour) picks the glyph, so files can be told
// apart without relying on colour.

export type FileKind = "code" | "data" | "doc" | "style" | "markup" | "image" | "shell" | "config" | "lock" | "test" | "generic";

const BY_EXT: Record<string, FileKind> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code", py: "code", rs: "code", go: "code", java: "code", kt: "code", cs: "code",
  c: "code", h: "code", cpp: "code", hpp: "code", rb: "code", php: "code", swift: "code", lua: "code", sql: "code", lock: "lock",
  json: "data", yaml: "data", yml: "data", toml: "data", csv: "data", xml: "data", jsonc: "data",
  md: "doc", mdx: "doc", txt: "doc", rst: "doc", pdf: "doc",
  css: "style", scss: "style", sass: "style", less: "style",
  html: "markup", htm: "markup", svg: "markup",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", ico: "image", bmp: "image",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "shell", bat: "shell", cmd: "shell",
  ini: "config", env: "config", conf: "config", cfg: "config",
};

const CONFIG_NAMES = new Set(["package.json", "tsconfig.json", "cargo.toml", "dockerfile", "makefile", ".gitignore", ".gitattributes", ".editorconfig", ".prettierrc", ".eslintrc", ".npmrc", ".forgerules", "vite.config.ts", "tailwind.config.js"]);
const LOCK_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "poetry.lock", "gemfile.lock"]);

export function fileKind(name: string): FileKind {
  const n = name.toLowerCase();
  if (LOCK_NAMES.has(n)) return "lock";
  if (/\.(test|spec)\.[a-z0-9]+$/.test(n)) return "test";
  if (CONFIG_NAMES.has(n) || /^\.env(\.|$)/.test(n) || /^\.[a-z]+rc(\.[a-z]+)?$/.test(n)) return "config";
  const dot = n.lastIndexOf(".");
  return (dot > 0 || (dot === 0 && n.length > 1) ? BY_EXT[n.slice(dot + 1)] : undefined) ?? "generic";
}

/** Folders that hold generated or vendored files: shown dimmed, since they are rarely where you work. */
const DIMMED_FOLDERS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", "__pycache__", "coverage", ".venv", "venv", ".cache"]);
export const isDimmedFolder = (name: string): boolean => DIMMED_FOLDERS.has(name.toLowerCase());
