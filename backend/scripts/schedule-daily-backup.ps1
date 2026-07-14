# Daily encrypted Postgres backup (Windows Task Scheduler helper)
# Run once as Administrator to register the scheduled task, or run manually anytime.
#
# Manual:
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-daily-backup.ps1 -RunNow
#
# Register daily 10:00 PM task:
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-daily-backup.ps1 -Register

param(
  [switch]$Register,
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'
$backendDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $backendDir 'scripts\backup-postgres.js'))) {
  $backendDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'backend'
}

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $backendDir 'scripts\backup-postgres.js'

if ($RunNow -or -not $Register) {
  Write-Host "Running backup from $backendDir ..."
  Push-Location $backendDir
  try {
    & $node $script
    if ($LASTEXITCODE -ne 0) { throw "Backup exited with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

if ($Register) {
  $taskName = 'YouthnicPostgresBackup'
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $backendDir
  $trigger = New-ScheduledTaskTrigger -Daily -At 10:00PM
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "Scheduled task '$taskName' registered for daily 10:00 PM."
  Write-Host "Copy backend\backups\*.enc to Google Drive after each run (or sync the backups folder)."
}
