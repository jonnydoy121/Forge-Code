// The editor engine (Monaco) is about 3 MB of JavaScript. It is loaded the first time a file is opened, or shortly after a
// workspace opens when the browser is idle, so the window, file tree and agent panel are interactive without waiting for
// it to download, parse and run. Everything else in the app talks to this thin facade, which has the same functions the
// engine does and does nothing (safely) while no document exists, because no document can exist before the engine has.

import type * as Impl from "./monaco-impl";

type Engine = typeof Impl;
export type { Doc, HunkMark } from "./monaco-impl";
import type { Doc } from "./monaco-impl";

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;

export function loadMonaco(): Promise<Engine> {
  loading ??= import("./monaco-impl").then((m) => (engine = m));
  return loading;
}

/** Load the engine in the background once the app has settled, so the first file still opens instantly. */
export function preloadMonaco(): void {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(() => void loadMonaco(), { timeout: 4000 });
  else setTimeout(() => void loadMonaco(), 1500);
}

export const getDoc = (path: string) => engine?.getDoc(path);
export const openDoc = async (path: string) => (await loadMonaco()).openDoc(path);
export const disposeDoc = (path: string) => engine?.disposeDoc(path);
export const saveDoc = async (path: string) => engine?.saveDoc(path);
export const isDirty = (d: Doc) => d.model.getAlternativeVersionId() !== d.savedAltVersion;
export const applyDiagnostics = (...a: Parameters<Engine["applyDiagnostics"]>): [number, number] => engine?.applyDiagnostics(...a) ?? [0, 0];
export const reloadOpenDocs = async (): Promise<string[]> => (engine ? engine.reloadOpenDocs() : []);
export const showPendingDecorations = (...a: Parameters<Engine["showPendingDecorations"]>) => engine?.showPendingDecorations(...a);
export const clearPendingDecorations = (...a: Parameters<Engine["clearPendingDecorations"]>) => engine?.clearPendingDecorations(...a);
export const errorMarkers = (...a: Parameters<Engine["errorMarkers"]>): ReturnType<Engine["errorMarkers"]> => engine?.errorMarkers(...a) ?? [];
