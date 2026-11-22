// Process entry point for `forge-code` (bundled by scripts/build-cli.mjs).
import { runCli } from "./cli";

runCli(process.argv.slice(2), {
  out: (t) => void process.stdout.write(t),
  err: (t) => void process.stderr.write(t),
  env: process.env,
  cwd: process.cwd(),
}).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`forge-code: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
