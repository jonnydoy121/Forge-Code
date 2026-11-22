/// <reference lib="webworker" />
import { serveRuntime } from "@forge/agent-runtime/src/remote";

serveRuntime(self as never);
