# Launches the real Forge window with a seeded workspace and runs the desktop Playwright specs against it.
# Usage: pwsh scripts/desktop-e2e.ps1 [spec-file-filter]
param([string]$Spec = "")
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$ws = Join-Path $env:TEMP "forge-e2e-ws"
if (Test-Path $ws) { Remove-Item -Recurse -Force $ws }
New-Item -ItemType Directory -Force $ws | Out-Null
Set-Content "$ws\a.ts" 'const x: number = "not a number";' -NoNewline
Set-Content "$ws\tsconfig.json" '{"compilerOptions":{"strict":true}}' -NoNewline
Set-Content "$ws\b.py" 'y: int = "no"' -NoNewline
Set-Content "$ws\c.ts" 'export function greet(name: string): string { return name; }' -NoNewline

Get-Process forge-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
$env:FORGE_WORKSPACE = $ws
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$log = Join-Path $env:TEMP "forge-dev.log"
$proc = Start-Process -FilePath npm.cmd -ArgumentList "run", "dev" -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
try {
  $up = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep 3
    try { Invoke-WebRequest http://127.0.0.1:9222/json/version -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break } catch {}
  }
  if (-not $up) { throw "Forge window did not expose CDP; see $log" }
  Start-Sleep 2
  $env:FORGE_CDP = "http://127.0.0.1:9222"
  $env:FORGE_WS = $ws
  Push-Location "$repo\apps\desktop"
  if ($Spec) { npx playwright test $Spec } else { npx playwright test }
  $code = $LASTEXITCODE
  Pop-Location
} finally {
  Get-Process forge-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
exit $code
