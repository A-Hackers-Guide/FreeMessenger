# FreeMessenger Computer Service Installer (Windows PowerShell)
# Run as: powershell -ExecutionPolicy Bypass -File install-computer-service.ps1

Write-Host "🔒 FreeMessenger Remote Access Service" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "⚠️  IMPORTANT: This installs a background service on your computer." -ForegroundColor Yellow
Write-Host ""
Write-Host "What this service does:"
Write-Host "  ✓ Allows you to share your computer with others for remote support"
Write-Host "  ✓ Shows a popup when someone requests access (you approve/deny)"
Write-Host "  ✓ Lets the service admin monitor activity to prevent abuse"
Write-Host "  ✓ Runs silently in the background when not in use"
Write-Host ""
Write-Host "To STOP this service at any time:"
Write-Host "  • Remove it from Services (services.msc) and restart"
Write-Host "  • Or run: Remove-ScheduledTask -TaskName 'FreeMessenger' -Confirm:$false"
Write-Host ""

$response = Read-Host "Do you understand and consent? (yes/no)"
if ($response -ne "yes") {
  Write-Host "Installation cancelled." -ForegroundColor Red
  exit 1
}

Write-Host "Installing FreeMessenger Computer Service..." -ForegroundColor Green

# Check Node.js
$nodeVersion = node --version 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "❌ Node.js not found. Please install Node.js v18+ from nodejs.org" -ForegroundColor Red
  exit 1
}

Write-Host "  ✓ Node.js $nodeVersion found" -ForegroundColor Green

# Create service directory
$serviceDir = "$env:APPDATA\FreeMessenger"
New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null

# Get configuration
$username = $env:USERNAME
$computerId = -join ((0..15) | ForEach-Object { '{0:X}' -f (Get-Random -Max 16) })
$hostname = $env:COMPUTERNAME

# Create batch file to run service
$batchFile = "$serviceDir\run-service.bat"
$batchContent = @"
@echo off
cd /d "$serviceDir"
node --input-type=module < "%~dp0computer-service.js"
"@
$batchContent | Out-File -FilePath $batchFile -Encoding ASCII

# Download service script
Write-Host "  Downloading service..." -ForegroundColor Cyan
$serviceUrl = "https://raw.githubusercontent.com/A-Hackers-Guide/FreeMessenger/main/server/computer-service.js"
try {
  Invoke-WebRequest -Uri $serviceUrl -OutFile "$serviceDir\computer-service.js" -ErrorAction Stop
  Write-Host "  ✓ Service downloaded" -ForegroundColor Green
} catch {
  Write-Host "  ❌ Failed to download service: $_" -ForegroundColor Red
  exit 1
}

# Create scheduled task
Write-Host "  Creating scheduled task..." -ForegroundColor Cyan
$taskAction = New-ScheduledTaskAction -Execute "$serviceDir\run-service.bat" -WorkingDirectory $serviceDir
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest -LogonType Interactive
$task = New-ScheduledTask -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Description "FreeMessenger Remote Access Service"

try {
  Register-ScheduledTask -TaskName "FreeMessenger" -InputObject $task -Force | Out-Null
  Write-Host "  ✓ Scheduled task created" -ForegroundColor Green
} catch {
  Write-Host "  ⚠️  Task creation failed: $_" -ForegroundColor Yellow
}

# Start the service
Write-Host "  Starting service..." -ForegroundColor Cyan
try {
  Start-ScheduledTask -TaskName "FreeMessenger" -ErrorAction Stop
  Write-Host "  ✓ Service started" -ForegroundColor Green
} catch {
  Write-Host "  ⚠️  Could not start immediately: $_" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✓ FreeMessenger Computer Service installed!" -ForegroundColor Green
Write-Host "  Service directory: $serviceDir"
Write-Host "  Log file: $serviceDir\service.log"
Write-Host ""
Write-Host "Next time you sign in, the service will start automatically."
Write-Host "You'll see popups when someone requests to access your computer."
