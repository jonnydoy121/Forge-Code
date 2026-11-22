import type { PermissionDecision, PermissionGate, ToolCall, ToolClass } from "@forge/protocol";

// ---------- deny list ----------

const DENY: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r\b)/i, "recursive delete (rm -rf)"],
  [/\b(del|erase)\s+(\/[a-z]\s+)*\/[sq]\b|\brmdir\s+\/s\b|\bRemove-Item\b.*-Recurse/i, "recursive delete"],
  [/\bgit\s+push\b/i, "git push (publishes commits)"],
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard (discards work)"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f (deletes untracked files)"],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, "discards all working-tree changes"],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdocker\s+push\b/i, "publishes a package or image"],
  [/\b(prisma\s+migrate\s+(deploy|reset)|rails\s+db:(migrate|drop|reset)|alembic\s+(upgrade|downgrade)|knex\s+migrate|sequelize\s+db:migrate|flyway\s+migrate|dropdb|DROP\s+(TABLE|DATABASE))\b/i, "database migration or destructive SQL"],
  [/(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|iex\s*\(.*(downloadstring|iwr|irm)/i, "pipes a download into a shell"],
  [/\bsudo\b|\brunas\b/i, "elevated privileges"],
  [/\b(mkfs|format\s+[a-z]:|dd\s+if=|shutdown|reboot)\b/i, "destructive system command"],
  [/\bchmod\s+-R\s+7{3}\b|\bchown\s+-R\b/i, "recursive permission change"],
  [/>\s*\/dev\/(sd|nvme)|:\(\)\s*\{/i, "destructive system command"],
  [/\bnpm\s+(config\s+set|login|adduser|token)\b/i, "changes credentials or registry config"],
];

/** Why a shell command always needs explicit confirmation, or null if it is not on the deny list. */
export function denyReason(command: string): string | null {
  for (const [re, why] of DENY) if (re.test(command)) return why;
  return null;
}

// ---------- permission store ----------

export type Remember = "once" | "session" | "always" | "deny";

export interface PermissionRule { tool: string; /** command prefix; empty = any call of the tool */ pattern: string }
export interface PermissionsFile { allow: PermissionRule[] }

const SHELL_OPS = /[;&|<>`\n\r]|\$\(/;

/** Pattern for "always allow this command pattern": the first two words, e.g. `npm test`. */
export function patternFor(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

function matches(rule: PermissionRule, tool: string, command: string | undefined): boolean {
  if (rule.tool !== tool) return false;
  if (!rule.pattern) return true;
  if (command === undefined) return false;
  const c = command.trim();
  if (c !== rule.pattern && !c.startsWith(rule.pattern + " ")) return false;
  // A remembered prefix must not authorise chained commands: "npm test; rm -rf ~".
  return !SHELL_OPS.test(c.slice(rule.pattern.length));
}

export interface AskRequest {
  tool: string;
  cls: ToolClass;
  summary: string;
  /** set for deny-listed commands: shown prominently, and "always allow" is not offered */
  danger?: string;
}

export interface GateOptions {
  ask(req: AskRequest): Promise<Remember>;
  load(): Promise<PermissionsFile>;
  save(file: PermissionsFile): Promise<void>;
  /** called for every decision, for the audit log */
  audit?(entry: { tool: string; cls: ToolClass; summary: string; decision: PermissionDecision | "allow-remembered"; danger?: string }): void;
}

const commandOf = (call: ToolCall) => (typeof call.args.command === "string" ? call.args.command : undefined);

/**
 * Permission gate. Reads are allowed; writes are governed by the review setting, not here. Execute and network
 * calls ask the first time ("allow once", "allow for this session", "always allow this command pattern"). Deny-listed
 * commands ask every time, even after "always", and can never be remembered.
 */
export function createPermissionGate(opts: GateOptions): PermissionGate & { resetSession(): void } {
  let session: PermissionRule[] = [];
  let persisted: PermissionsFile | null = null;
  return {
    resetSession: () => {
      session = [];
    },
    async check(cls, call): Promise<PermissionDecision> {
      if (cls === "read" || cls === "write" || cls === "plan") return "allow";
      const command = commandOf(call);
      const summary = command ? `${call.name}: ${command}` : `${call.name} ${JSON.stringify(call.args).slice(0, 120)}`;
      const danger = command ? denyReason(command) : null;
      if (!danger) {
        persisted ??= await opts.load();
        if ([...session, ...persisted.allow].some((r) => matches(r, call.name, command))) {
          opts.audit?.({ tool: call.name, cls, summary, decision: "allow-remembered" });
          return "allow";
        }
      }
      const answer = await opts.ask({ tool: call.name, cls, summary, danger: danger ?? undefined });
      const decision: PermissionDecision = answer === "deny" ? "deny" : "allow";
      opts.audit?.({ tool: call.name, cls, summary, decision, danger: danger ?? undefined });
      if (answer === "session" && !danger) session.push({ tool: call.name, pattern: command ? patternFor(command) : "" });
      if (answer === "always" && !danger) {
        persisted ??= await opts.load();
        persisted.allow.push({ tool: call.name, pattern: command ? patternFor(command) : "" });
        await opts.save(persisted);
      }
      return decision;
    },
  };
}
