// Panel sizes: how wide the explorer and the agent column are, kept within sensible limits and remembered between sessions.

export interface Limits {
  min: number;
  max: number;
  def: number;
}

export const EXPLORER: Limits = { min: 160, max: 480, def: 240 };
export const AGENT: Limits = { min: 300, max: 760, def: 384 };
/** The editor in the middle never gets narrower than this, whatever the side panels are set to. */
export const MIN_CENTER = 320;

export interface Layout {
  explorer: number;
  agent: number;
}

export const clamp = (w: number, min: number, max: number): number => Math.round(Math.min(Math.max(w, min), Math.max(min, max)));

/** The largest a panel may be right now: its own limit, and leaving the middle and the other panel their room. */
export function maxFor(own: Limits, windowWidth: number, otherWidth: number): number {
  return Math.max(own.min, Math.min(own.max, windowWidth - otherWidth - MIN_CENTER));
}

/**
 * The new width after a key press on a splitter, or null for a key that does nothing. `grow` is 1 when the panel is left of its splitter
 * (the right arrow widens it) and -1 when it is on the right (the left arrow widens it). Shift takes bigger steps; Home and End go to the limits.
 */
export function stepWidth(key: string, shift: boolean, width: number, min: number, max: number, grow: 1 | -1): number | null {
  const step = shift ? 64 : 16;
  if (key === "ArrowRight") return clamp(width + step * grow, min, max);
  if (key === "ArrowLeft") return clamp(width - step * grow, min, max);
  if (key === "Home") return min;
  if (key === "End") return max;
  return null;
}

const KEY = "forge.layout.v1";

export function loadLayout(storage: Pick<Storage, "getItem"> = localStorage): Layout {
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? "null") as Partial<Layout> | null;
    const num = (v: unknown, l: Limits) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, l.min, l.max) : l.def);
    return { explorer: num(raw?.explorer, EXPLORER), agent: num(raw?.agent, AGENT) };
  } catch {
    return { explorer: EXPLORER.def, agent: AGENT.def };
  }
}

export function saveLayout(layout: Layout, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable: the sizes simply are not remembered */
  }
}
