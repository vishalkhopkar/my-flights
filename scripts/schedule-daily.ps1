# Creates (or updates) one Windows scheduled task per job, each running scripts\run-tracker.ps1 -Job <job> once a day
# at the local time set in config.json under "runTimes" (24-hour HH:mm):
#
#   runTimes.flight     task MyFlightsDailyTracker     flight-prompt.md    (Gmail -> flights.json)
#   runTimes.hotel      task MyFlightsHotelTracker     hotel-prompt.md     (Gmail -> hotels.json)
#   runTimes.transport  task MyFlightsTransportTracker transport-prompt.md (Gmail -> transport.json)
#   runTimes.combined   task MyFlightsCombinedTrips    combined-prompt.md  (the three files -> trips/)
#
# A job whose time is null or missing gets no task, and an existing task for it is removed.
# Keep the combined time after the other three: it only rebuilds when one of them logged a change that day.
#
#   powershell -File scripts\schedule-daily.ps1               create / update the tasks
#   powershell -File scripts\schedule-daily.ps1 -Unregister   remove all of them
#
# The tasks run as the current user, only while logged on (the Gmail connector uses your Claude Code login). If the PC
# is off or asleep at the set time, a task runs when the PC is next available. Times are the PC's local clock.

param([switch]$Unregister)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $Root 'scripts\run-tracker.ps1'

$Tasks = [ordered]@{
    flight    = @{ Name = 'MyFlightsDailyTracker';      Desc = 'Runs flight-prompt.md headlessly and logs the result to log.csv' }
    hotel     = @{ Name = 'MyFlightsHotelTracker';      Desc = 'Runs hotel-prompt.md headlessly and logs the result to log.csv' }
    transport = @{ Name = 'MyFlightsTransportTracker';  Desc = 'Runs transport-prompt.md headlessly and logs the result to log.csv' }
    combined  = @{ Name = 'MyFlightsCombinedTrips';     Desc = 'Runs combined-prompt.md headlessly (builds trips/) and logs the result to log.csv' }
}

function Remove-TaskIfExists([string]$name) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        return $true
    }
    return $false
}

if ($Unregister) {
    foreach ($job in $Tasks.Keys) {
        $n = $Tasks[$job].Name
        if (Remove-TaskIfExists $n) { Write-Output "Removed scheduled task '$n'." } else { Write-Output "No task '$n'." }
    }
    return
}

$config = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $config.runTimes) { throw 'config.json: runTimes is missing (expected {"flight": "08:00", "hotel": "08:30", "transport": "09:00", "combined": "09:30"})' }

# validate every time first, so a typo does not leave the tasks half updated
$times = @{}
foreach ($job in $Tasks.Keys) {
    $at = $config.runTimes.$job
    if ($null -eq $at -or [string]$at -eq '') { $times[$job] = $null; continue }
    $at = [string]$at
    if ($at -notmatch '^([01]?\d|2[0-3]):([0-5]\d)$') {
        throw "config.json: runTimes.$job must be 24-hour HH:mm (e.g. ""08:00""), got '$at'"
    }
    $times[$job] = [datetime]::Today.AddHours([int]$Matches[1]).AddMinutes([int]$Matches[2])
}

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)

foreach ($job in $Tasks.Keys) {
    $name = $Tasks[$job].Name
    if ($null -eq $times[$job]) {
        if (Remove-TaskIfExists $name) { Write-Output "runTimes.$job is not set: removed '$name'." }
        else { Write-Output "runTimes.$job is not set: no task for '$job'." }
        continue
    }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" -Job $job" `
        -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -Daily -At $times[$job]
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
        -Description $Tasks[$job].Desc -Force | Out-Null
    $info = Get-ScheduledTaskInfo -TaskName $name
    Write-Output ("Scheduled '{0}' ({1}) daily at {2} (local time). Next run: {3}" -f $name, $job, $times[$job].ToString('HH:mm'), $info.NextRunTime)
}
