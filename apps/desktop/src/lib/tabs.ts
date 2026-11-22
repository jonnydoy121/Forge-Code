export interface Tab {
  path: string;
  name: string;
  dirty: boolean;
}

export interface TabsState {
  tabs: Tab[];
  active: string | null;
}

export type TabsAction =
  | { type: "open"; path: string }
  | { type: "close"; path: string }
  | { type: "activate"; path: string }
  | { type: "dirty"; path: string; dirty: boolean }
  | { type: "reset" };

export const initialTabs: TabsState = { tabs: [], active: null };

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open":
      if (state.tabs.some((t) => t.path === action.path)) return { ...state, active: action.path };
      return { tabs: [...state.tabs, { path: action.path, name: baseName(action.path), dirty: false }], active: action.path };
    case "activate":
      return state.tabs.some((t) => t.path === action.path) ? { ...state, active: action.path } : state;
    case "dirty":
      return { ...state, tabs: state.tabs.map((t) => (t.path === action.path ? { ...t, dirty: action.dirty } : t)) };
    case "close": {
      const idx = state.tabs.findIndex((t) => t.path === action.path);
      if (idx < 0) return state;
      const tabs = state.tabs.filter((t) => t.path !== action.path);
      let active = state.active;
      if (active === action.path) active = tabs[Math.min(idx, tabs.length - 1)]?.path ?? null;
      return { tabs, active };
    }
    case "reset":
      return initialTabs;
  }
}
