import type { TabsState } from "../lib/tabs";

interface Props {
  state: TabsState;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

/**
 * Tabs are buttons with role=tab. The close "x" is a mouse affordance inside the tab (not a second control, which
 * would nest interactive elements); keyboard users close the active tab with Ctrl+W or the palette.
 */
export function TabBar({ state, onActivate, onClose }: Props) {
  const has = state.tabs.length > 0;
  return (
    <div className="flex overflow-x-auto border-b border-[var(--border)] bg-[var(--panel)]" role={has ? "tablist" : undefined} aria-label={has ? "Open files" : undefined}>
      {state.tabs.map((t) => (
        <button
          key={t.path}
          role="tab"
          aria-selected={state.active === t.path}
          title={`${t.path} (Ctrl+W closes)`}
          className={`flex shrink-0 items-center gap-2 border-r border-[var(--border)] px-3 py-1.5 text-sm ${state.active === t.path ? "bg-[var(--bg)]" : "text-[var(--muted)]"}`}
          onClick={() => onActivate(t.path)}
          onAuxClick={() => onClose(t.path)}
        >
          <span>
            {t.name}
            {t.dirty ? <span aria-label="unsaved changes"> ●</span> : null}
          </span>
          <span
            aria-hidden="true"
            className="w-4 rounded text-xs hover:bg-[var(--hover)]"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.path);
            }}
          >
            ×
          </span>
        </button>
      ))}
    </div>
  );
}
