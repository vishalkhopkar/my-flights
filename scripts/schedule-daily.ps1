# Creates (or updates) the Windows scheduled task that runs scripts\run-tracker.ps1 once a day
# at the local time set in config.json ("runTimes.flight", 24-hour HH:mm).
#
#   powershell -File scripts\schedule-daily.ps1               create / update the task
#   powershell -File scripts\schedule-daily.ps1 -Unregister   remove it
#
# The task runs as the current user, only while logged on (the Gmail connector uses your
# Claude Code login). If the PC is off or asleep at the set time, it runs when the PC is next available.

param([switch]$Unregister)

$ErrorActionPreference = 'Stop'
$TaskName = 'MyFlightsDailyTracker'
$Root = Split-Path -Parent $PSScriptRoot

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed scheduled task '$TaskName'."
    return
}

$config = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$at = [string]$config.runTimes.flight
if ($at -notmatch '^([01]?\d|2[0-3]):([0-5]\d)$') {
    throw "config.json: runTimes.flight must be 24-hour HH:mm (e.g. ""08:00""), got '$at'"
}
$time = [datetime]::Today.AddHours([int]$Matches[1]).AddMinutes([int]$Matches[2])

$script = Join-Path $Root 'scripts\run-tracker.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
    -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Runs flight-prompt.md headlessly and logs the result to log.csv' -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output ("Scheduled '{0}' daily at {1} (local time). Next run: {2}" -f $TaskName, $time.ToString('HH:mm'), $info.NextRunTime)
