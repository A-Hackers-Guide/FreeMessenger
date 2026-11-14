# Resets the Sunshine web-UI login when you've forgotten the password.
#
# RIGHT-CLICK this file -> "Run with PowerShell", and approve the admin prompt
# (it needs admin to restart the Sunshine service). It does NOT touch your
# Moonlight device pairings — only the web login.
#
# After it runs, open Sunshine (in FreeMessenger -> My services, or
# https://localhost:47990) and set a new username and password.

$ErrorActionPreference = "Stop"

# Re-launch elevated if we're not already admin.
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  return
}

$cfg = "C:\Program Files\Sunshine\config\sunshine_state.json"
if (-not (Test-Path $cfg)) { Write-Host "Can't find Sunshine's config at $cfg" -ForegroundColor Red; Read-Host "Press Enter to close"; return }

Write-Host "Stopping Sunshine..."
Stop-Service SunshineService -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$backup = "$cfg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $cfg $backup
Write-Host "Backed up to $backup"

$j = Get-Content $cfg -Raw | ConvertFrom-Json
foreach ($f in "username", "password", "salt") { $j.PSObject.Properties.Remove($f) }
$json = $j | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($cfg, $json, (New-Object System.Text.UTF8Encoding($false)))  # no BOM

Write-Host "Starting Sunshine..."
Start-Service SunshineService

Write-Host ""
Write-Host "Done. Open Sunshine and set a new username + password:" -ForegroundColor Green
Write-Host "  - in FreeMessenger: My services -> Sunshine, or"
Write-Host "  - in a browser: https://localhost:47990"
Read-Host "Press Enter to close"
