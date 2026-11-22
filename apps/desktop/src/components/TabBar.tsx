import type { TabsState } from "../lib/tabs";

interface Props {
  state: TabsState;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

export function TabBar({ state, onActivate, onClose }: Props) {
  return (
    <div className="flex overflow-x-auto border-b border-[var(--border)] bg-[var(--panel)]" role="tablist">
      {state.tabs.map((t) => (
        <div
          key={t.path}
          role="tab"
          aria-selected={state.active === t.path}
          title={t.path}
          className={`flex shrink-0 cursor-pointer items-center gap-2 border-r border-[var(--border)] px-3 py-1.5 text-sm ${state.active === t.path ? "bg-[var(--bg)]" : "text-[var(--muted)]"}`}
          onClick={() => onActivate(t.path)}
          onAuxClick={() => onClose(t.path)}
        >
          <span>{t.name}</span>
          <button
            aria-label={`Close ${t.name}`}
            className="w-4 rounded text-xs hover:bg-[var(--hover)]"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.path);
            }}
          >
            {t.dirty ? "●" : "×"}
          </button>
        </div>
      ))}
    </div>
  );
}
