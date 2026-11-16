param(
  [ValidateSet("install", "uninstall", "status")]
  [string]$Action = "install",
  [string]$TaskName = "DoorWatchServer",
  [switch]$WithSimulator
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Action -eq "status") {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "[doorwatch] Scheduled task '$TaskName' is not installed."
    exit 0
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "[doorwatch] Task: $TaskName | State: $($task.State) | LastResult: $($info.LastTaskResult) | LastRun: $($info.LastRunTime)"
  exit 0
}

if ($Action -eq "uninstall") {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Host "[doorwatch] Scheduled task '$TaskName' is not installed."
    exit 0
  }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[doorwatch] Removed scheduled task '$TaskName'."
  exit 0
}

# Action = install
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "[doorwatch] Node.js was not found in PATH. Install Node.js 22.13+ first."
}
$nodePath = $nodeCmd.Source

$serverDataDir = Join-Path $ProjectRoot "server-data"
if (-not (Test-Path $serverDataDir)) {
  New-Item -ItemType Directory -Path $serverDataDir -Force | Out-Null
}
$logPath = Join-Path $serverDataDir "autostart.log"

$startArgs = "scripts\start-windows.mjs --wait-mongo"
if ($WithSimulator) {
  $startArgs += " --with-simulator"
}

$cmdArgs = "/c `"`"$nodePath`" $startArgs >> `"$logPath`" 2>&1`""
$taskAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmdArgs -WorkingDirectory $ProjectRoot

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

$isAdmin = Test-IsAdmin
if ($isAdmin) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $taskAction `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "DoorWatch Local web UI and collector server" `
    -Force | Out-Null
  Write-Host "[doorwatch] Installed '$TaskName' to auto-start at Windows boot (SYSTEM)."
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $taskAction `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "DoorWatch Local web UI and collector server" `
    -Force | Out-Null
  Write-Host "[doorwatch] Installed '$TaskName' to auto-start when '$env:USERNAME' logs into Windows."
  Write-Host "[doorwatch] Tip: Run install-autostart.bat as Administrator if you want it to start before user login."
}

Write-Host "[doorwatch] Logs will be written to: $logPath"
Start-ScheduledTask -TaskName $TaskName
Write-Host "[doorwatch] Started '$TaskName' in the background."
