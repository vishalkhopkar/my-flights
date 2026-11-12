# Runs flight-prompt.md in a headless Claude Code session and appends one row to log.csv.
#
#   run_date  scan start time (UTC), same value the run writes to flights.json "runDate"
#   success   Claude Code ran AND flights.json came back valid and freshly stamped
#             (i.e. Gmail could be read; "ERROR: Gmail unavailable" counts as a failure)
#   changed   the "data" array of flights.json differs from before the run
#   type      kind of run: "flight" (a hotel run would log "hotel")
#
# On any failure flights.json is restored to its pre-run content.
# Usage: powershell -File scripts\run-tracker.ps1   (normally started by the scheduled task)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

$Flights    = Join-Path $Root 'flights.json'
$PromptFile = Join-Path $Root 'flight-prompt.md'
$LogCsv     = Join-Path $Root 'log.csv'
$LastRun    = Join-Path $Root 'last-run.txt'
$TimeoutMin = 90
$Utf8       = New-Object System.Text.UTF8Encoding($false)
$Culture    = [System.Globalization.CultureInfo]::InvariantCulture

$ExpectedKeys = 'id,departureDate,departureDay,departureTime,sourceAirport,source,arrivalDate,arrivalDay,arrivalTime,destinationAirport,destination,flightNumber,airline,airlineCode,pnr,class,passenger,notes,hidden'

# Tools the unattended session may use. Everything else is denied (dontAsk mode).
# Gmail is read-only; writes are limited to the tracker's own files.
$Allowed = @(
    'Read', 'ToolSearch', 'WebFetch', 'WebSearch',
    'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude_ai_Gmail__get_thread',
    'mcp__claude_ai_Gmail__get_message',
    'mcp__claude_ai_Gmail__download_gmail_attachment',
    'Edit(flights.json)', 'Edit(flights.tmp.json)', 'Edit(flights.backup.json)',
    'Bash(cp flights.json flights.backup.json)',
    'Bash(mv flights.tmp.json flights.json)',
    'Bash(node scripts/fetch-logos.js)'
)
$Denied = @(
    'send_message', 'reply', 'forward', 'create_draft', 'update_draft', 'delete_draft',
    'create_label', 'update_label', 'delete_label', 'label_message', 'label_thread',
    'unlabel_message', 'unlabel_thread', 'apply_sensitive_message_label', 'apply_sensitive_thread_label',
    'mark_message_spam', 'mark_thread_spam', 'unmark_message_spam', 'unmark_thread_spam',
    'trash_message', 'trash_thread', 'untrash_message', 'untrash_thread'
) | ForEach-Object { "mcp__claude_ai_Gmail__$_" }

function Get-RunDate([string]$raw) {
    if ($raw -match '"runDate"\s*:\s*"([^"]+)"') { return $Matches[1] }
    return $null
}

# Returns @{ RunDate; DataJson; Valid } for a flights.json text; $null when it cannot be parsed.
function Read-FlightsText([string]$raw) {
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try { $obj = $raw | ConvertFrom-Json } catch { return $null }
    if ($null -eq $obj -or $null -eq $obj.data) { return $null }
    $rows = @($obj.data)
    $valid = $true
    foreach ($r in $rows) {
        if (($r.PSObject.Properties.Name -join ',') -ne $ExpectedKeys) { $valid = $false; break }
        if (($r.id -isnot [int] -and $r.id -isnot [long]) -or $r.hidden -isnot [bool] -or $r.airlineCode -cnotmatch '^[a-z0-9]{2,3}$') { $valid = $false; break }
    }
    return @{
        RunDate  = Get-RunDate $raw
        DataJson = ($rows | ConvertTo-Json -Depth 10 -Compress)
        Valid    = ($valid -and [bool](Get-RunDate $raw))
    }
}

function Quote-Arg([string]$a) { '"' + ($a -replace '"', '\"') + '"' }

# ---------------------------------------------------------------------------
$runStart = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $Culture)

if (-not (Test-Path -LiteralPath $LogCsv) -or (Get-Item -LiteralPath $LogCsv).Length -eq 0) {
    [System.IO.File]::WriteAllText($LogCsv, "run_date,success,changed,type`r`n", $Utf8)
}

$beforeRaw = $null
if (Test-Path -LiteralPath $Flights) { $beforeRaw = [System.IO.File]::ReadAllText($Flights, $Utf8) }
$before = Read-FlightsText $beforeRaw
if ($null -ne $beforeRaw) { [System.IO.File]::WriteAllText((Join-Path $Root 'flights.backup.json'), $beforeRaw, $Utf8) }

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }

$reason  = ''
$timedOut = $false
$exit    = -1
$stdout  = ''
$stderr  = ''

try {
    if (-not (Test-Path -LiteralPath $claude)) { throw "claude CLI not found ($claude)" }
    if (-not (Test-Path -LiteralPath $PromptFile)) { throw 'flight-prompt.md not found' }

    $argList = @('-p', '--permission-mode', 'dontAsk', '--no-session-persistence', '--max-turns', '250', '--allowedTools') +
               $Allowed + @('--disallowedTools') + $Denied

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $claude
    $psi.Arguments = ($argList | ForEach-Object { Quote-Arg $_ }) -join ' '
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $Utf8
    $psi.StandardErrorEncoding = $Utf8
    $psi.CreateNoWindow = $true

    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()

    $promptText = "RUN_START = $runStart`n`n" + [System.IO.File]::ReadAllText($PromptFile, $Utf8)
    $promptBytes = $Utf8.GetBytes($promptText)
    $p.StandardInput.BaseStream.Write($promptBytes, 0, $promptBytes.Length)
    $p.StandardInput.Close()

    if (-not $p.WaitForExit($TimeoutMin * 60000)) {
        $timedOut = $true
        & taskkill.exe /T /F /PID $p.Id | Out-Null
        $p.WaitForExit()
    }
    $exit = $p.ExitCode
    $stdout = $outTask.Result
    $stderr = $errTask.Result
}
catch {
    $reason = "runner error: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
$success = $false
$changed = $false

if (-not $reason) {
    if ($timedOut) { $reason = "timed out after $TimeoutMin min" }
    elseif ($exit -ne 0) { $reason = "claude exited with code $exit" }
    elseif ($stdout -match '(?m)^\s*ERROR:\s*Gmail unavailable') { $reason = 'Gmail unavailable' }
}

if (-not $reason) {
    $afterRaw = if (Test-Path -LiteralPath $Flights) { [System.IO.File]::ReadAllText($Flights, $Utf8) } else { $null }
    $after = Read-FlightsText $afterRaw
    if ($null -eq $after) { $reason = 'flights.json missing or unparsable after run' }
    elseif (-not $after.Valid) { $reason = 'flights.json failed schema check after run' }
    elseif ($null -ne $before -and $after.RunDate -eq $before.RunDate) { $reason = 'runDate was not updated (nothing was scanned)' }
    elseif ($after.RunDate -lt $runStart) { $reason = "runDate $($after.RunDate) is older than this run's start" }
    else {
        $success = $true
        $changed = ($null -eq $before) -or ($after.DataJson -ne $before.DataJson)
    }
}

if (-not $success) {
    # put back exactly what was there before the run
    if ($null -ne $beforeRaw) { [System.IO.File]::WriteAllText($Flights, $beforeRaw, $Utf8) }
    elseif (Test-Path -LiteralPath $Flights) { Remove-Item -LiteralPath $Flights -Force }
}

# logo cache: done here so it does not depend on Claude's shell permissions (only downloads missing logos)
if ($success) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($node) { try { & $node (Join-Path $Root 'scripts\fetch-logos.js') | Out-Null } catch { } }
}

$row = '{0},{1},{2},{3}' -f $runStart, $success.ToString().ToLower(), $changed.ToString().ToLower(), 'flight'
[System.IO.File]::AppendAllText($LogCsv, $row + "`r`n", $Utf8)

$report = @(
    "run_date : $runStart",
    "success  : $success",
    "changed  : $changed",
    "reason   : $(if ($reason) { $reason } else { 'ok' })",
    "exit code: $exit",
    '',
    '--- stdout ---', $stdout,
    '--- stderr ---', $stderr
) -join "`r`n"
[System.IO.File]::WriteAllText($LastRun, $report, $Utf8)

Write-Output $row
if ($reason) { Write-Output "reason: $reason" }
