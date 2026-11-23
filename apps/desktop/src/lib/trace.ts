/**
 * Named timestamps for finding where time goes. Free unless something (a test, the console) sets `window.__trace = []`:
 *   window.__trace = [];  ...do the thing...  console.table(window.__trace)
 */
export function mark(label: string): void {
  const t = (globalThis as { __trace?: [string, number][] }).__trace;
  if (t) t.push([label, performance.now()]);
}
