import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyApi } from "../lib/ipc";
import { terminalRegistry } from "../lib/terminalRegistry";

interface Props {
  cwd: string | null;
  visible: boolean;
  dark: boolean;
}

export function Terminal({ cwd, visible, dark }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    const t = new XTerm({ fontFamily: "Consolas, monospace", fontSize: 13, cursorBlink: true });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    f.fit();
    term.current = t;
    fit.current = f;
    terminalRegistry.read = () => {
      const buf = t.buffer.active;
      const lines: string[] = [];
      for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n").trim();
    };
    let disposed = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      unlisten = await ptyApi.onData((id, data) => {
        if (id === idRef.current) t.write(data);
      });
      const id = await ptyApi.spawn(cwd, t.cols, t.rows);
      if (disposed) return void ptyApi.kill(id);
      idRef.current = id;
      t.onData((d) => void ptyApi.write(id, d));
    })().catch((e) => t.write(`\r\nterminal failed to start: ${e}\r\n`));

    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetHeight) return;
      f.fit();
      if (idRef.current !== null) void ptyApi.resize(idRef.current, t.cols, t.rows);
    });
    ro.observe(host.current!);

    return () => {
      disposed = true;
      terminalRegistry.read = () => "";
      ro.disconnect();
      unlisten?.();
      if (idRef.current !== null) void ptyApi.kill(idRef.current);
      t.dispose();
    };
  }, [cwd]);

  useEffect(() => {
    if (term.current) term.current.options.theme = dark ? { background: "#18181b" } : { background: "#ffffff", foreground: "#18181b", cursor: "#18181b" };
  }, [dark]);

  useEffect(() => {
    if (visible) {
      fit.current?.fit();
      term.current?.focus();
    }
  }, [visible]);

  return <div ref={host} className="h-full w-full p-1" data-testid="terminal" />;
}
