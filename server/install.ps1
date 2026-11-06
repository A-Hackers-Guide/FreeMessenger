# Sets up FreeMessenger's home relay and TURN server on Windows, in one go.
#
#   powershell -ExecutionPolicy Bypass -File server\install.ps1 -Admin yourname
#
# Needs Node.js 22.13 or newer and Docker Desktop. Running it again updates the
# code and keeps your data, keys and settings.
#
#   -Admin    your FreeMessenger username (several: "name1,name2")
#   -Folder   where everything goes (default E:\FreeMessenger)
#   -CapGB    the most storage messages may use (default 100)
#   -BackupFolder  where nightly database copies go, ideally another drive (default H:\FreeMessenger-backups)
#   -NoTurn   skip the TURN server

param(
  [Parameter(Mandatory = $true)] [string]$Admin,
  [string]$Folder = "E:\FreeMessenger",
  [int]$CapGB = 100,
  [string]$BackupFolder = "H:\FreeMessenger-backups",
  [switch]$NoTurn
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $Folder "app"
$data = Join-Path $Folder "data"

Write-Host "Copying the relay to $app"
New-Item -ItemType Directory -Force -Path "$app\server", "$app\relay\src", $data | Out-Null
Copy-Item "$here\server.js", "$here\proxy.js", "$here\setup.mjs", "$here\package.json", "$here\package-lock.json" "$app\server" -Force
Copy-Item "$here\..\relay\src\shared.js" "$app\relay\src" -Force
Set-Content -Path "$app\relay\package.json" -Value '{ "type": "module" }' -Encoding ascii
Push-Location "$app\server"
npm ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE) { throw "npm ci failed" }
Pop-Location

# cloudflared makes the free quick tunnel that lets the app reach this PC.
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { $cloudflared = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cloudflared)) {
  Write-Host "Installing cloudflared"
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements | Out-Null
  $cloudflared = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
}

# The router, for keeping the TURN port forwards (NAT-PMP).
$gateway = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4DefaultGateway.NextHop
node "$app\server\setup.mjs" $data --admin $Admin --cap $CapGB --cloudflared $cloudflared --backup-dir $BackupFolder --gateway $gateway | Tee-Object -Variable setupOut
if ($LASTEXITCODE) { throw "setup failed" }
# The data folder holds the sync key and TURN secret: only this account may read it.
icacls $data /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
if ($BackupFolder) {
  New-Item -ItemType Directory -Force -Path $BackupFolder | Out-Null
  icacls $BackupFolder /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
}

if (-not $NoTurn) {
  Write-Host "Starting the TURN server (Docker)"
  $cfg = Get-Content "$data\config.json" -Raw | ConvertFrom-Json
  $turnScript = Join-Path $data "turn.ps1"
  @"
docker rm -f freemessenger-turn 2>`$null | Out-Null
docker run -d --name freemessenger-turn --restart unless-stopped ``
  -p 3478:3478 -p 3478:3478/udp -p 40000-40040:40000-40040/udp ``
  coturn/coturn@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3 -n --log-file=stdout --listening-port=3478 --min-port=40000 --max-port=40040 ``
  '--external-ip=`$(detect-external-ip)' --realm=freemessenger --use-auth-secret '--static-auth-secret=$($cfg.turn.secret)' ``
  --fingerprint --no-multicast-peers ``
  --denied-peer-ip=0.0.0.0-0.255.255.255 --denied-peer-ip=10.0.0.0-10.255.255.255 ``
  --denied-peer-ip=100.64.0.0-100.127.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255 ``
  --denied-peer-ip=169.254.0.0-169.254.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 ``
  --denied-peer-ip=192.168.0.0-192.168.255.255 --user-quota=4 --total-quota=20 --max-bps=500000 *> '$data\turn.log'
"@ | Set-Content -Path $turnScript -Encoding utf8
  if ($env:SSH_CONNECTION) {
    # Over SSH, Docker can't download images, so run it in your Windows session.
    $t = "FreeMessenger TURN setup"
    Register-ScheduledTask -TaskName $t -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$turnScript`"") -Force | Out-Null
    Start-ScheduledTask -TaskName $t
    for ($i = 0; $i -lt 90 -and (Get-ScheduledTask -TaskName $t).State -eq "Running"; $i++) { Start-Sleep -Seconds 2 }
    Unregister-ScheduledTask -TaskName $t -Confirm:$false
  } else {
    & $turnScript
  }
  if (-not (docker ps --filter name=freemessenger-turn --format "{{.Names}}")) { Write-Warning "The TURN server didn't start (see $data\turn.log). Is Docker Desktop running?" }
}

# Runs the relay, and starts it again if it ever stops.
$node = (Get-Command node).Source
$runner = Join-Path $data "run.ps1"
@"
Set-Location '$app\server'
while (`$true) {
  & '$node' '$app\server\server.js' '$data' 2>&1 | Out-File -Append -Encoding utf8 '$data\relay.log'
  Start-Sleep -Seconds 5
}
"@ | Set-Content -Path $runner -Encoding utf8

$task = "FreeMessenger relay"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$app\server\server.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" | Where-Object { $_.CommandLine -like "*127.0.0.1:*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName $task

Write-Host ""
Write-Host "Done. The relay starts whenever you sign in to Windows. Log: $data\relay.log"
Write-Host "Put this line in relay/wrangler.toml under [vars] (it's a public key, safe to share):"
$setupOut | Where-Object { $_ -like "PRIMARY_KEY=*" }
if (-not $NoTurn) { Write-Host "The relay asks your router to forward the TURN ports (NAT-PMP). If the admin panel's Activity tab says that failed, forward UDP+TCP 3478 and UDP 40000-40040 to this PC by hand." }
