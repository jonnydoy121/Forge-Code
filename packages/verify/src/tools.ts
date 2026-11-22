import type { RegisteredTool } from "@forge/tool-host";
import { formatReport, type TouchedFile, type VerificationReport } from "./checks";

export interface VerifyToolDeps {
  /** Runs the project's configured checks for the given files. */
  runner(phase: "fast" | "full", touched: TouchedFile[]): Promise<VerificationReport>;
  /** Files changed in this session (workspace-relative), used when the model does not name files. */
  touched(): TouchedFile[];
}

/** `run_checks`: runs only the project's own configured checks (never arbitrary commands). Execute-class, so it is permission-gated. */
export function createVerifyTools(deps: VerifyToolDeps): RegisteredTool[] {
  return [
    {
      spec: {
        name: "run_checks",
        description:
          "Run the project's configured format, lint, typecheck and test commands (from AGENTS.md ## Commands) and return structured results. scope 'fast' checks touched files and related tests; 'full' also runs the whole test suite.",
        parameters: { type: "object", properties: { scope: { type: "string", enum: ["fast", "full"] }, files: { type: "array", items: { type: "string" } } } },
        class: "execute",
      },
      async run(args) {
        const files = Array.isArray(args.files) ? (args.files as unknown[]).filter((f): f is string => typeof f === "string") : null;
        const touched = files ? files.map((path) => ({ path, created: false })) : deps.touched();
        return formatReport(await deps.runner(args.scope === "full" ? "full" : "fast", touched));
      },
    },
  ];
}
