import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands, type Command } from "../lib/commands";

interface Props {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => input.current?.focus(), []);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-20" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Command palette"
        className="h-fit w-[560px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          data-testid="palette-input"
          value={query}
          placeholder="Type a command"
          className="w-full bg-transparent px-4 py-3 text-sm outline-none"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, results.length - 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter") run(results[index]);
          }}
        />
        <ul className="max-h-72 overflow-auto border-t border-[var(--border)]" role="listbox">
          {results.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === index}
              className={`flex cursor-pointer justify-between px-4 py-1.5 text-sm ${i === index ? "bg-[var(--hover)]" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(c)}
            >
              <span>{c.title}</span>
              <span className="text-xs text-[var(--muted)]">{c.keybinding}</span>
            </li>
          ))}
          {results.length === 0 && <li className="px-4 py-2 text-sm text-[var(--muted)]">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
