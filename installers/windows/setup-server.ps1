# FreeMessenger Server setup: asks for your username, makes sure Node.js is
# installed, then runs install.ps1 (which you can also run by hand).
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "FreeMessenger Server setup" -ForegroundColor Cyan
Write-Host "This turns this PC into your FreeMessenger home relay: texts, calls and the admin panel go through it."
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
$ok = $false
if ($node) { $v = [version]((node --version).TrimStart("v")); $ok = $v -ge [version]"22.13" }
if (-not $ok) {
  Write-Host "Installing Node.js (needed to run the relay)..."
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

$admin = ""
while ($admin -notmatch '^@?[a-zA-Z0-9_]{3,20}$') {
  $admin = (Read-Host "Your FreeMessenger username (you become the admin)").Trim()
}
$opts = @("-Admin", $admin.TrimStart("@").ToLower())
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker Desktop isn't installed, so the calls relay (TURN) is skipped. Calls still work on most networks." -ForegroundColor Yellow
  $opts += "-NoTurn"
}
& (Join-Path $here "server\install.ps1") @opts
Write-Host ""
Write-Host "All set. You can close this window." -ForegroundColor Green
Read-Host "Press Enter to close"
