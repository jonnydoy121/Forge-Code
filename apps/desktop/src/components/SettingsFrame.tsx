import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The empty element in the editor area that Settings is drawn into. */
export const SETTINGS_HOST_ID = "settings-host";

/**
 * Settings as a page of its own over the editor area, with a list of its sections on the left, instead of a cramped strip inside the
 * 384-pixel agent panel. The settings content itself stays where it was (it needs the panel's state); this only gives it somewhere roomy to
 * be drawn. Without the host element it falls back to the old inline strip. Esc closes it.
 */
export function SettingsFrame({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(() => document.getElementById(SETTINGS_HOST_ID));
  const [sections, setSections] = useState<string[]>([]);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => setHost(document.getElementById(SETTINGS_HOST_ID)), []);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !(e.target instanceof HTMLSelectElement)) onClose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  // The list of sections is read from the headings themselves, so a new section shows up in it without a second list to keep in step.
  useEffect(() => {
    const names = [...(body.current?.querySelectorAll("h3") ?? [])].map((h) => h.textContent ?? "").filter(Boolean);
    setSections((prev) => (prev.length === names.length && prev.every((n, i) => n === names[i]) ? prev : names));
  });

  if (!host) return <div className="max-h-[60vh] overflow-y-auto border-b border-[var(--border)] p-3">{children}</div>;

  return createPortal(
    <div className="absolute inset-0 z-20 flex flex-col bg-[var(--bg)]" data-testid="settings-page" role="region" aria-label="Settings">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm">
        <strong>Settings</strong>
        <span className="text-[var(--muted)]">Esc closes</span>
        <button className="ml-auto underline" data-testid="settings-close" onClick={onClose}>Close</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" data-testid="settings-nav" className="hidden w-48 shrink-0 overflow-y-auto border-r border-[var(--border)] p-3 text-sm lg:block">
          <ul className="space-y-1">
            {sections.map((name, i) => (
              <li key={`${name}${i}`}>
                <button className="w-full rounded px-2 py-1 text-left text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]" onClick={() => body.current?.querySelectorAll("h3")[i]?.scrollIntoView({ block: "start", behavior: "smooth" })}>
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div ref={body} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl p-5">{children}</div>
        </div>
      </div>
    </div>,
    host,
  );
}
