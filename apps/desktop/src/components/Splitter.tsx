import { useRef } from "react";
import { stepWidth } from "../lib/layout";

interface Props {
  /** what this resizes, for screen readers: "Explorer width" */
  label: string;
  width: number;
  min: number;
  max: number;
  /** 1: the panel is on the left of this bar (dragging right widens it). -1: the panel is on the right (dragging left widens it). */
  grow: 1 | -1;
  onChange: (width: number) => void;
  onReset: () => void;
  testId: string;
}

/** A draggable, keyboard-operable divider between panels (the ARIA "window splitter" pattern). Double-click puts the panel back to its usual width. */
export function Splitter({ label, width, min, max, grow, onChange, onReset, testId }: Props) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={testId}
      title="Drag to resize; double-click to reset"
      className="group relative z-10 w-1 shrink-0 cursor-col-resize touch-none bg-transparent outline-none hover:bg-[var(--border)] focus-visible:bg-blue-500/60"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, w: width };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.style.userSelect = "none"; // dragging must not select text underneath
      }}
      onPointerMove={(e) => {
        if (drag.current) onChange(Math.round(Math.min(Math.max(drag.current.w + (e.clientX - drag.current.x) * grow, min), max)));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        document.body.style.userSelect = "";
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const next = stepWidth(e.key, e.shiftKey, width, min, max, grow);
        if (next !== null) {
          e.preventDefault();
          onChange(next);
        }
      }}
    >
      {/* a wider invisible target than the 4px line, so it is easy to grab */}
      <span className="absolute inset-y-0 -left-1 -right-1" aria-hidden="true" />
    </div>
  );
}
