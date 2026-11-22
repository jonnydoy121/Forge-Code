// Entry point of the standalone runtime process (`forge-runtime`): the agent loop over stdin/stdout.
// stdout carries protocol lines only; diagnostics go to stderr.
import { serveRuntime } from "./remote";
import { lineSplitter, linePort } from "./stdio";

const split = (cb: (l: string) => void) => {
  const feed = lineSplitter(cb);
  process.stdin.on("data", (c) => feed(c));
  process.stdin.on("end", () => process.exit(0)); // the host went away: exit with it
};
serveRuntime(linePort((line) => void process.stdout.write(line + "\n"), split));
