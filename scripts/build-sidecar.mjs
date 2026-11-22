// Builds the standalone agent-runtime process (`forge-runtime`) as a Node single-executable and places it where Tauri's
// `externalBin` expects it: apps/desktop/src-tauri/binaries/forge-runtime-<target-triple>[.exe].
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "target", "sidecar");
const bin = join(root, "apps", "desktop", "src-tauri", "binaries");
mkdirSync(out, { recursive: true });
mkdirSync(bin, { recursive: true });

const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)[1];
const ext = process.platform === "win32" ? ".exe" : "";

await build({ entryPoints: [join(root, "packages/agent-runtime/src/sidecar-main.ts")], bundle: true, platform: "node", format: "cjs", outfile: join(out, "runtime.cjs"), minify: true, logLevel: "warning" });
writeFileSync(join(out, "sea-config.json"), JSON.stringify({ main: join(out, "runtime.cjs"), output: join(out, `forge-runtime${ext}`), disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--build-sea", join(out, "sea-config.json")], { stdio: "inherit" });
const dest = join(bin, `forge-runtime-${triple}${ext}`);
copyFileSync(join(out, `forge-runtime${ext}`), dest);
console.log("sidecar built:", dest);
