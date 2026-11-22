// Measures the REAL release app: how long until it is usable, how much memory it holds, and what it costs while idle.
//   node scripts/perf-startup.mjs [runs] [path-to-exe]
// Needs `npx tauri build --no-bundle` first. Windows only (reads the process tree with PowerShell).
// Prints one JSON object with the median of each metric over the runs.
/* global performance -- used inside page.evaluate, which runs in the app's webview */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.argv[2] ?? 5);
const exe = process.argv[3] ?? join(root, "target", "release", "forge-desktop.exe");
const { chromium } = createRequire(join(root, "apps", "desktop", "package.json"))("@playwright/test");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function cdpUp(port) {
  return new Promise((ok) => {
    const req = get({ host: "127.0.0.1", port, path: "/json/version", timeout: 500 }, (res) => (res.resume(), ok(res.statusCode === 200)));
    req.on("error", () => ok(false));
    req.on("timeout", () => (req.destroy(), ok(false)));
  });
}

/** Working set (MB) and total CPU seconds of the app and every process it started (the WebView2 children). */
function tree(pid) {
  const ps = `
    $all = Get-CimInstance Win32_Process
    $ids = @(${pid}); $grew = $true
    while ($grew) { $grew = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and $ids -notcontains $p.ProcessId) { $ids += $p.ProcessId; $grew = $true } } }
    $procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
    $ws = ($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB
    $cpu = ($procs | Measure-Object CPU -Sum).Sum
    "$([math]::Round($ws,1)) $([math]::Round($cpu,3)) $($procs.Count)"`;
  const [ws, cpu, n] = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split(" ").map(Number);
  return { ws, cpu, n };
}

async function once(i) {
  const port = 9400 + i;
  const ws = mkdtempSync(join(tmpdir(), "forge-perf-ws-"));
  writeFileSync(join(ws, "a.ts"), "export const a = 1;\n");
  const t0 = Date.now();
  const child = spawn(exe, [], { env: { ...process.env, FORGE_WORKSPACE: ws, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" });
  try {
    while (!(await cdpUp(port))) {
      if (Date.now() - t0 > 60_000) throw new Error("window did not come up");
      await sleep(25);
    }
    const toWindow = Date.now() - t0;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('[data-testid="editor"]', { state: "attached", timeout: 60_000 });
    // The first paint can land after the shell is mounted; wait for the browser to report it rather than reading too early.
    await page.waitForFunction(() => performance.getEntriesByType("paint").some((p) => p.name === "first-contentful-paint"), null, { timeout: 15_000 }).catch(() => {});
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const fcp = performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint");
      const js = performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js"));
      return { domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, fcp: fcp ? fcp.startTime : null, editorReady: performance.now(), jsFiles: js.length, jsKB: Math.round(js.reduce((s, r) => s + (r.encodedBodySize || 0), 0) / 1024) };
    });
    // Settle, then sample memory and 5 s of CPU while the app sits idle.
    await sleep(3000);
    const a = tree(child.pid);
    await sleep(5000);
    const b = tree(child.pid);
    await browser.close();
    return { toWindow, ...m, memoryMB: b.ws, processes: b.n, idleCpuPct: Math.round(((b.cpu - a.cpu) / 5) * 1000) / 10 };
  } finally {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(500);
  }
}

const results = [];
for (let i = 0; i < runs; i++) results.push(await once(i));
const keys = Object.keys(results[0]);
const out = Object.fromEntries(keys.map((k) => [k, median(results.map((r) => r[k] ?? 0))]));
console.log(JSON.stringify({ runs, exe, median: out, all: results }, null, 2));
