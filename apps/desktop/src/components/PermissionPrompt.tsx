import type { AskRequest, Remember } from "@forge/safety";

interface Props {
  req: AskRequest;
  onAnswer: (a: Remember) => void;
}

export function PermissionPrompt({ req, onAnswer }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-label="Permission request" data-testid="permission-prompt">
      <div className="w-[480px] rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-sm shadow-2xl">
        <h2 className="mb-2 font-semibold">The agent wants to {req.cls === "network" ? "use the network" : "run a command"}</h2>
        <pre className="mb-2 whitespace-pre-wrap rounded bg-[var(--hover)] p-2 font-mono text-xs">{req.summary}</pre>
        {req.danger && (
          <p className="mb-2 rounded bg-red-900/40 p-2 text-red-200" data-testid="permission-danger">
            Dangerous: {req.danger}. This always asks, even if you allowed similar commands before.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-green-700/70 px-3 py-1" data-testid="allow-once" onClick={() => onAnswer("once")} autoFocus>Allow once</button>
          {!req.danger && <button className="rounded bg-[var(--hover)] px-3 py-1" data-testid="allow-session" onClick={() => onAnswer("session")}>Allow for this session</button>}
          {!req.danger && <button className="rounded bg-[var(--hover)] px-3 py-1" data-testid="allow-always" onClick={() => onAnswer("always")}>Always allow this pattern</button>}
          <button className="ml-auto rounded bg-red-700/70 px-3 py-1" data-testid="deny" onClick={() => onAnswer("deny")}>Deny</button>
        </div>
      </div>
    </div>
  );
}
