import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fsApi, type DirEntry } from "../lib/ipc";

interface Props {
  root: string;
  activePath: string | null;
  onOpen: (path: string) => void;
}

interface Row {
  entry: DirEntry;
  depth: number;
  parent: string;
}

// Mid-tone colors that read on both the dark and the light theme.
const EXT_COLOR: Record<string, string> = {
  ts: "#3b82f6", tsx: "#3b82f6", js: "#ca8a04", jsx: "#ca8a04", mjs: "#ca8a04", cjs: "#ca8a04", json: "#d97706", md: "#64748b",
  rs: "#ea580c", py: "#16a34a", css: "#9333ea", html: "#dc2626", toml: "#0d9488", yaml: "#0d9488", yml: "#0d9488", sh: "#16a34a",
};

function colorFor(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXT_COLOR[ext] ?? "currentColor";
}

function Icon({ entry, open }: { entry: DirEntry; open: boolean }) {
  return entry.is_dir ? (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-[#d4a72c]">
      <path fill="currentColor" d={open ? "M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5.5V6H4.2a1 1 0 0 0-.96.72L1.5 12.5V4Zm2.7 3h11.1a.5.5 0 0 1 .48.64l-1.5 5A1 1 0 0 1 13.32 13.4H2.6a.5.5 0 0 1-.48-.64L3.7 7.5A.5.5 0 0 1 4.2 7Z" : "M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5.5v6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V4Z"} />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-[var(--muted)]" style={{ color: colorFor(entry.name) }}>
      <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" d="M4 1.8h5l3.2 3.2v9.2H4V1.8Zm5 0V5h3.2" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={`shrink-0 text-[var(--muted)] transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FileTree({ root, activePath, onOpen }: Props) {
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(async (dir: string) => {
    try {
      const entries = await fsApi.listDir(dir);
      setChildren((c) => ({ ...c, [dir]: entries }));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    setChildren({});
    setExpanded(new Set([root]));
    setError(null);
    setFocused(null);
    void load(root);
  }, [root, load]);

  const expand = (dir: string) => {
    setExpanded((prev) => new Set(prev).add(dir));
    if (!children[dir]) void load(dir);
  };
  const collapse = (dir: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });
  const toggle = (dir: string) => (expanded.has(dir) ? collapse(dir) : expand(dir));

  // The rows that are on screen, in order: what the arrow keys walk through.
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of children[dir] ?? []) {
        out.push({ entry, depth, parent: dir });
        if (entry.is_dir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [children, expanded, root]);

  // One Tab stop for the whole tree (roving tabindex): the focused row, else the open file, else the first row.
  const tabStop = rows.find((r) => r.entry.path === focused)?.entry.path ?? rows.find((r) => r.entry.path === activePath)?.entry.path ?? rows[0]?.entry.path;

  const moveTo = (path: string | undefined) => {
    if (!path) return;
    setFocused(path);
    items.current.get(path)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.entry.path === tabStop);
    const row = rows[i];
    if (!row) return;
    switch (e.key) {
      case "ArrowDown":
        moveTo(rows[Math.min(i + 1, rows.length - 1)]?.entry.path);
        break;
      case "ArrowUp":
        moveTo(rows[Math.max(i - 1, 0)]?.entry.path);
        break;
      case "Home":
        moveTo(rows[0]?.entry.path);
        break;
      case "End":
        moveTo(rows[rows.length - 1]?.entry.path);
        break;
      case "ArrowRight":
        if (!row.entry.is_dir) return;
        if (!expanded.has(row.entry.path)) expand(row.entry.path);
        else if (rows[i + 1] && rows[i + 1]!.depth > row.depth) moveTo(rows[i + 1]!.entry.path);
        break;
      case "ArrowLeft":
        if (row.entry.is_dir && expanded.has(row.entry.path)) collapse(row.entry.path);
        else if (row.parent !== root) moveTo(row.parent);
        break;
      default:
        return; // Enter and Space activate the focused row through its own click
    }
    e.preventDefault();
  };

  const render = (dir: string, depth: number): React.ReactNode =>
    (children[dir] ?? []).map((e) => {
      const open = e.is_dir && expanded.has(e.path);
      return (
        <div key={e.path} role="none">
          <button
            ref={(el) => {
              if (el) items.current.set(e.path, el);
              else items.current.delete(e.path);
            }}
            role="treeitem"
            tabIndex={tabStop === e.path ? 0 : -1}
            aria-expanded={e.is_dir ? open : undefined}
            aria-selected={activePath === e.path}
            aria-level={depth + 1}
            className={`flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-sm hover:bg-[var(--hover)] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-blue-400 ${activePath === e.path ? "bg-[var(--hover)]" : ""}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => {
              setFocused(e.path);
              if (e.is_dir) toggle(e.path);
              else onOpen(e.path);
            }}
            onFocus={() => setFocused(e.path)}
            data-testid={`tree-${e.name}`}
          >
            <span className="flex w-2.5 justify-center">{e.is_dir && <Chevron open={open} />}</span>
            <Icon entry={e} open={open} />
            <span className="truncate">{e.name}</span>
          </button>
          {open && <div role="group">{render(e.path, depth + 1)}</div>}
        </div>
      );
    });

  return (
    <div className="h-full overflow-auto py-1" role="tree" aria-label="Files" onKeyDown={onKeyDown}>
      {error && <div className="px-2 text-sm text-red-400">{error}</div>}
      {render(root, 0)}
    </div>
  );
}
