interface Tip {
  label: string;
  hint: string;
  keys?: string[];
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 align-middle">
      {keys.map((k, i) => (
        <span key={`${k}${i}`} className="inline-flex items-center gap-0.5">
          {i > 0 && <span aria-hidden="true">+</span>}
          <kbd className="rounded border border-[var(--border)] bg-[var(--hover)] px-1 font-mono text-[11px] text-[var(--fg)]">{k}</kbd>
        </span>
      ))}
    </span>
  );
}

/** Shown where the editor will be until a file is open: what to do first, with the real shortcuts. */
export function EmptyEditor({ hasFolder, agentOpen }: { hasFolder: boolean; agentOpen: boolean }) {
  const tips: Tip[] = hasFolder
    ? [
        { label: "Open a file", hint: "click one in the explorer" },
        { label: "Ask the agent", hint: agentOpen ? "type in the panel on the right" : "show the agent panel", keys: agentOpen ? undefined : ["Ctrl", "L"] },
        { label: "Review changes", hint: "when the agent proposes edits", keys: ["Ctrl", "Shift", "R"] },
        { label: "Run a command", hint: "open the command palette", keys: ["Ctrl", "Shift", "P"] },
      ]
    : [
        { label: "Open a folder", hint: "to start", keys: ["Ctrl", "O"] },
        { label: "Run a command", hint: "open the command palette", keys: ["Ctrl", "Shift", "P"] },
      ];
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg)] p-6" data-testid="empty-editor">
      <div className="max-w-md text-sm text-[var(--muted)]">
        <p className="mb-3 text-base font-semibold text-[var(--fg)]">{hasFolder ? "Nothing open yet" : "Forge-Code"}</p>
        <ul className="space-y-2">
          {tips.map((t) => (
            <li key={t.label}>
              <span className="text-[var(--fg)]">{t.label}</span> <span>— {t.hint}</span>
              {t.keys && <Keys keys={t.keys} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
