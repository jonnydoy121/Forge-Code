import { useCallback, useEffect, useState } from "react";
import { fsApi, type DirEntry } from "../lib/ipc";

interface Props {
  root: string;
  activePath: string | null;
  onOpen: (path: string) => void;
}

export function FileTree({ root, activePath, onOpen }: Props) {
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [error, setError] = useState<string | null>(null);

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
    void load(root);
  }, [root, load]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!children[dir]) void load(dir);
      }
      return next;
    });
  };

  const render = (dir: string, depth: number): React.ReactNode =>
    (children[dir] ?? []).map((e) => (
      <div key={e.path} role="none">
        <button
          role="treeitem"
          aria-expanded={e.is_dir ? expanded.has(e.path) : undefined}
          aria-selected={activePath === e.path}
          className={`flex w-full items-center gap-1 truncate px-2 py-0.5 text-left text-sm hover:bg-[var(--hover)] ${activePath === e.path ? "bg-[var(--hover)]" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => (e.is_dir ? toggle(e.path) : onOpen(e.path))}
          data-testid={`tree-${e.name}`}
        >
          <span className="w-3 text-[var(--muted)]">{e.is_dir ? (expanded.has(e.path) ? "v" : ">") : ""}</span>
          <span className="truncate">{e.name}</span>
        </button>
        {e.is_dir && expanded.has(e.path) && <div role="group">{render(e.path, depth + 1)}</div>}
      </div>
    ));

  return (
    <div className="h-full overflow-auto py-1" role="tree" aria-label="Files">
      {error && <div className="px-2 text-sm text-red-400">{error}</div>}
      {render(root, 0)}
    </div>
  );
}
