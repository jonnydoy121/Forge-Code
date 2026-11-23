// Process entry point for `forge-code` (bundled by scripts/build-cli.mjs).
import { runCli } from "./cli";
import { runSchedule } from "./schedule";
import { runServe } from "./serve";

const args = process.argv.slice(2);
// `schedule` has its own sub-commands; everything else is ask or run.
(args[0] === "schedule" ? runSchedule.bind(null, args.slice(1)) : args[0] === "serve" ? runServe.bind(null, args.slice(1)) : runCli.bind(null, args))({
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
