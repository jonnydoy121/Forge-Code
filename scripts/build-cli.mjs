// Bundles the headless CLI into one file: node target/cli/forge-code.cjs run "..." --model ...
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build({ entryPoints: [join(root, "packages/cli/src/main.ts")], bundle: true, platform: "node", format: "cjs", outfile: join(root, "target/cli/forge-code.cjs"), minify: true, logLevel: "warning" });
console.log("cli built:", join(root, "target/cli/forge-code.cjs"));
