/** Shown where the editor will be until a file is open: what to do first, with the real shortcuts. */
export function EmptyEditor({ hasFolder, agentOpen }: { hasFolder: boolean; agentOpen: boolean }) {
  const tips: [string, string][] = hasFolder
    ? [
        ["Open a file", "click one in the explorer"],
        ["Ask the agent", agentOpen ? "type in the panel on the right" : "Ctrl+L shows the agent panel"],
        ["Review changes", "Ctrl+Shift+R, when the agent has proposed edits"],
        ["Run a command", "Ctrl+Shift+P opens the command palette"],
      ]
    : [
        ["Open a folder", "Ctrl+O"],
        ["Run a command", "Ctrl+Shift+P"],
      ];
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg)] p-6" data-testid="empty-editor">
      <div className="max-w-sm text-sm text-[var(--muted)]">
        <p className="mb-3 text-base font-semibold text-[var(--fg)]">{hasFolder ? "Nothing open yet" : "Forge-Code"}</p>
        <ul className="space-y-1.5">
          {tips.map(([k, v]) => (
            <li key={k}>
              <span className="text-[var(--fg)]">{k}</span> <span>— {v}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
