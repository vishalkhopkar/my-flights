# Runs one tracker prompt in a headless Claude Code session and appends one row to log.csv.
#
#   powershell -File scripts\run-tracker.ps1 -Job flight       flight-prompt.md    -> flights.json
#   powershell -File scripts\run-tracker.ps1 -Job hotel        hotel-prompt.md     -> hotels.json
#   powershell -File scripts\run-tracker.ps1 -Job transport    transport-prompt.md -> transport.json
#   powershell -File scripts\run-tracker.ps1 -Job combined     combined-prompt.md  -> trips/ (one file per person)
#   powershell -File scripts\run-tracker.ps1 -Job hotel -CheckOnly    validate the current output, run nothing
#
# -Job defaults to flight, so a task registered before the other jobs existed keeps working.
# Normally started by the scheduled tasks that scripts\schedule-daily.ps1 creates.
#
# log.csv columns:
#   run_date  scan start time (UTC), same value the run writes as "runDate" (combined: "generatedAt")
#   success   Claude Code ran AND the output came back valid and freshly stamped
#             (source jobs: Gmail could be read; "ERROR: Gmail unavailable" counts as a failure.
#              combined: also true when the run decided there was nothing to rebuild, "SKIPPED:")
#   changed   the "data" array (combined: the trips, ignoring timestamps) differs from before the run
#   type      which job ran: flight | hotel | transport | combined
#
# On any failure the output is restored to its pre-run content. The full output of the last run of each job is
# in last-run-<job>.txt.
#
# The combined job has no Gmail access and cannot run shell commands. It writes its files into trips.tmp\ and this
# script validates them (JSON, schema, every id reference resolves) and then swaps them into trips\, keeping the
# previous folder as trips.backup\.

param(
    [ValidateSet('flight', 'hotel', 'transport', 'combined')][string]$Job = 'flight',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

$LogCsv  = Join-Path $Root 'log.csv'
$LastRun = Join-Path $Root "last-run-$Job.txt"
$Utf8    = New-Object System.Text.UTF8Encoding($false)
$Culture = [System.Globalization.CultureInfo]::InvariantCulture
$TripsDir   = Join-Path $Root 'trips'
$TripsTmp   = Join-Path $Root 'trips.tmp'
$TripsBak   = Join-Path $Root 'trips.backup'

# ---------------------------------------------------------------------------
# Job definitions
# ---------------------------------------------------------------------------
$Jobs = @{
    flight = @{
        Prompt = 'flight-prompt.md'; Data = 'flights.json'; Base = 'flights'; TimeoutMin = 90; Gmail = $true; Logos = $true
        Keys = 'id,departureDate,departureDay,departureTime,sourceAirport,source,arrivalDate,arrivalDay,arrivalTime,destinationAirport,destination,flightNumber,airline,airlineCode,pnr,class,passenger,notes,hidden'
        Extra = { param($r) if ($r.airlineCode -cnotmatch '^[a-z0-9]{2,3}$') { 'airlineCode must be 2-3 lowercase characters' } }
    }
    hotel = @{
        Prompt = 'hotel-prompt.md'; Data = 'hotels.json'; Base = 'hotels'; TimeoutMin = 90; Gmail = $true; Logos = $false
        Keys = 'id,checkInDate,checkInDay,checkInTime,checkOutDate,checkOutDay,checkOutTime,nights,propertyName,city,country,address,googleMapsUrl,latitude,longitude,bookedVia,confirmationNumber,roomType,guests,noOfGuests,notes,hidden'
        Extra = { param($r) if ($r.checkInDate -cnotmatch '^\d{4}-\d{2}-\d{2}$') { 'checkInDate must be YYYY-MM-DD' } }
    }
    transport = @{
        Prompt = 'transport-prompt.md'; Data = 'transport.json'; Base = 'transport'; TimeoutMin = 90; Gmail = $true; Logos = $false
        Keys = 'id,term,transportType,provider,vehicle,serviceNumber,startDate,startDay,endDate,endDay,days,departureDate,departureDay,departureTime,departureLocation,arrivalDate,arrivalDay,arrivalTime,arrivalLocation,bookedVia,confirmationNumber,noOfPassengers,passengers,notes,hidden'
        Extra = { param($r) if (@('longTerm', 'shortTerm', 'overnight') -cnotcontains $r.term) { 'term must be longTerm, shortTerm or overnight' } }
    }
    combined = @{
        Prompt = 'combined-prompt.md'; TimeoutMin = 45; Gmail = $false
    }
}
$Cfg = $Jobs[$Job]
$PromptFile = Join-Path $Root $Cfg.Prompt

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Arr($v) { if ($null -eq $v) { return @() } return @($v) }

function Quote-Arg([string]$a) { '"' + ($a -replace '"', '\"') + '"' }

function Get-RunDate([string]$raw) {
    if ($raw -match '"runDate"\s*:\s*"([^"]+)"') { return $Matches[1] }
    return $null
}

# Source jobs: returns @{ RunDate; DataJson; Problem } for a flights/hotels/transport.json text, or $null when it cannot
# be parsed at all. Problem is $null when the file matches the schema.
function Read-SourceText([string]$raw, $cfg) {
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try { $obj = $raw | ConvertFrom-Json } catch { return $null }
    if ($null -eq $obj -or $null -eq $obj.data) { return $null }
    $rows = @($obj.data)
    $problem = $null

    if (($obj.PSObject.Properties.Name -join ',') -ne 'runDate,nextId,data') { $problem = 'top-level keys must be runDate, nextId, data' }
    elseif ($obj.nextId -isnot [int] -and $obj.nextId -isnot [long]) { $problem = 'nextId must be an integer' }
    elseif (-not (Get-RunDate $raw)) { $problem = 'runDate missing' }

    $seen = @{}
    $max = 0
    foreach ($r in $rows) {
        if ($problem) { break }
        if (($r.PSObject.Properties.Name -join ',') -ne $cfg.Keys) { $problem = 'a record does not have the expected keys in order'; break }
        if ($r.id -isnot [int] -and $r.id -isnot [long]) { $problem = 'a record id is not an integer'; break }
        if ($seen.ContainsKey([string]$r.id)) { $problem = "duplicate id $($r.id)"; break }
        $seen[[string]$r.id] = $true
        if ($r.id -gt $max) { $max = [long]$r.id }
        if ($r.hidden -isnot [bool]) { $problem = "record $($r.id): hidden must be true or false"; break }
        $extra = & $cfg.Extra $r
        if ($extra) { $problem = "record $($r.id): $extra"; break }
    }
    if (-not $problem -and $obj.nextId -le $max) { $problem = "nextId ($($obj.nextId)) must be greater than every id ($max)" }

    return @{
        RunDate  = Get-RunDate $raw
        DataJson = ($rows | ConvertTo-Json -Depth 10 -Compress)
        Problem  = $problem
    }
}

# id -> hidden flag, for the combined job's reference check
function Get-IdMap([string]$file) {
    $map = @{}
    $p = Join-Path $Root $file
    if (Test-Path -LiteralPath $p) {
        $o = [System.IO.File]::ReadAllText($p, $Utf8) | ConvertFrom-Json
        foreach ($r in (Arr $o.data)) { $map[[string]$r.id] = [bool]$r.hidden }
    }
    return $map
}

# Combined job: validates a trips folder. Returns $null when fine, otherwise the first problem found.
function Test-TripsDir([string]$dir, [string]$minGenerated) {
    $idxPath = Join-Path $dir 'index.json'
    if (-not (Test-Path -LiteralPath $idxPath)) { return 'index.json is missing' }
    try { $idx = [System.IO.File]::ReadAllText($idxPath, $Utf8) | ConvertFrom-Json } catch { return 'index.json is not valid JSON' }
    $people = Arr $idx.people
    if ($people.Count -eq 0) { return 'index.json lists nobody' }
    if ($minGenerated -and ([string]$idx.generatedAt) -lt $minGenerated) { return "index.json generatedAt ($($idx.generatedAt)) is older than this run" }

    $maps = @{ flights = (Get-IdMap 'flights.json'); hotels = (Get-IdMap 'hotels.json'); transport = (Get-IdMap 'transport.json') }
    function Bad($source, $id) {
        $m = $maps[[string]$source]
        if ($null -eq $m) { return "unknown source '$source'" }
        if (-not $m.ContainsKey([string]$id)) { return "$source id $id does not exist" }
        if ($m[[string]$id]) { return "$source id $id is hidden but referenced" }
        return $null
    }

    foreach ($p in $people) {
        $f = [string]$p.file
        if ($f -cnotmatch '^[a-z0-9-]+\.json$') { return "index.json has a bad file name '$f'" }
        $path = Join-Path $dir $f
        if (-not (Test-Path -LiteralPath $path)) { return "$f is listed in index.json but missing" }
        try { $pj = [System.IO.File]::ReadAllText($path, $Utf8) | ConvertFrom-Json } catch { return "$f is not valid JSON" }
        if ($pj.PSObject.Properties.Name -cnotcontains 'trips' -or $pj.PSObject.Properties.Name -cnotcontains 'person') { return "$f lacks person or trips" }
        foreach ($t in (Arr $pj.trips)) {
            foreach ($s in (Arr $t.segments)) { $e = Bad $s.source $s.id; if ($e) { return "$f trip $($t.id): $e" } }
            foreach ($h in (Arr $t.stays)) { $e = Bad 'hotels' $h; if ($e) { return "$f trip $($t.id): $e" } }
            foreach ($x in (Arr $t.longTermTransport)) { $e = Bad 'transport' $x; if ($e) { return "$f trip $($t.id): $e" } }
        }
        if ($pj.unassigned) {
            foreach ($k in 'flights', 'hotels', 'transport') {
                foreach ($i in (Arr $pj.unassigned.$k)) { $e = Bad $k $i; if ($e) { return "$f unassigned: $e" } }
            }
        }
    }
    return $null
}

# name -> text for every .json file in a folder
function Get-JsonSnapshot([string]$dir) {
    $snap = @{}
    if (Test-Path -LiteralPath $dir) {
        foreach ($f in Get-ChildItem -LiteralPath $dir -Filter '*.json' -File) { $snap[$f.Name] = [System.IO.File]::ReadAllText($f.FullName, $Utf8) }
    }
    return $snap
}

# Comparable signature of a snapshot that ignores the timestamps, so "changed" means the trips themselves changed
function Get-TripsSignature($snap) {
    $parts = foreach ($name in ($snap.Keys | Sort-Object)) {
        try {
            $o = $snap[$name] | ConvertFrom-Json
            $o = $o | Select-Object -Property * -ExcludeProperty generatedAt, sourceRunDates
            $name + '=' + ($o | ConvertTo-Json -Depth 30 -Compress)
        } catch { $name + '=unparsable' }
    }
    return ($parts -join "`n")
}

function Restore-Trips($snap) {
    if (-not (Test-Path -LiteralPath $TripsDir)) { New-Item -ItemType Directory -Path $TripsDir | Out-Null }
    foreach ($f in Get-ChildItem -LiteralPath $TripsDir -Filter '*.json' -File) {
        if (-not $snap.ContainsKey($f.Name)) { Remove-Item -LiteralPath $f.FullName -Force }
    }
    foreach ($name in $snap.Keys) { [System.IO.File]::WriteAllText((Join-Path $TripsDir $name), $snap[$name], $Utf8) }
}

# Moves a validated trips.tmp into trips (index.json last), keeping the previous folder as trips.backup
function Publish-Trips() {
    if (Test-Path -LiteralPath $TripsDir) {
        if (Test-Path -LiteralPath $TripsBak) { Remove-Item -LiteralPath $TripsBak -Recurse -Force }
        Copy-Item -LiteralPath $TripsDir -Destination $TripsBak -Recurse
    } else {
        New-Item -ItemType Directory -Path $TripsDir | Out-Null
    }
    $idx = [System.IO.File]::ReadAllText((Join-Path $TripsTmp 'index.json'), $Utf8) | ConvertFrom-Json
    $names = @(Arr $idx.people | ForEach-Object { [string]$_.file })
    foreach ($n in $names) { Move-Item -LiteralPath (Join-Path $TripsTmp $n) -Destination (Join-Path $TripsDir $n) -Force }
    Move-Item -LiteralPath (Join-Path $TripsTmp 'index.json') -Destination (Join-Path $TripsDir 'index.json') -Force
    $keep = $names + 'index.json'
    foreach ($f in Get-ChildItem -LiteralPath $TripsDir -Filter '*.json' -File) {
        if ($keep -cnotcontains $f.Name) { Remove-Item -LiteralPath $f.FullName -Force }
    }
    Remove-Item -LiteralPath $TripsTmp -Recurse -Force
}

# ---------------------------------------------------------------------------
# -CheckOnly: validate what is on disk now, run nothing, write nothing
# ---------------------------------------------------------------------------
if ($CheckOnly) {
    if ($Job -eq 'combined') {
        $p = Test-TripsDir $TripsDir ''
        if ($p) { Write-Output "combined: INVALID - $p"; exit 1 }
        Write-Output 'combined: ok (trips/ parses and every id reference resolves)'
        exit 0
    }
    $path = Join-Path $Root $Cfg.Data
    $raw = if (Test-Path -LiteralPath $path) { [System.IO.File]::ReadAllText($path, $Utf8) } else { $null }
    $r = Read-SourceText $raw $Cfg
    if ($null -eq $r) { Write-Output "${Job}: INVALID - $($Cfg.Data) missing or unparsable"; exit 1 }
    if ($r.Problem) { Write-Output "${Job}: INVALID - $($r.Problem)"; exit 1 }
    Write-Output "${Job}: ok ($($Cfg.Data), runDate $($r.RunDate))"
    exit 0
}

# ---------------------------------------------------------------------------
# Permissions for the unattended session (dontAsk mode denies everything not listed here)
# ---------------------------------------------------------------------------
$Allowed = @('Read', 'ToolSearch', 'WebFetch', 'WebSearch')
$Denied = @()
if ($Cfg.Gmail) {
    # Gmail is read-only; writes are limited to this job's own files.
    $Allowed += @(
        'mcp__claude_ai_Gmail__search_threads',
        'mcp__claude_ai_Gmail__get_thread',
        'mcp__claude_ai_Gmail__get_message',
        'mcp__claude_ai_Gmail__download_gmail_attachment',
        "Edit($($Cfg.Data))", "Edit($($Cfg.Base).tmp.json)", "Edit($($Cfg.Base).backup.json)",
        "Bash(cp $($Cfg.Data) $($Cfg.Base).backup.json)",
        "Bash(mv $($Cfg.Base).tmp.json $($Cfg.Data))"
    )
    if ($Cfg.Logos) { $Allowed += 'Bash(node scripts/fetch-logos.js)' }
    $Denied = @(
        'send_message', 'reply', 'forward', 'create_draft', 'update_draft', 'delete_draft',
        'create_label', 'update_label', 'delete_label', 'label_message', 'label_thread',
        'unlabel_message', 'unlabel_thread', 'apply_sensitive_message_label', 'apply_sensitive_thread_label',
        'mark_message_spam', 'mark_thread_spam', 'unmark_message_spam', 'unmark_thread_spam',
        'trash_message', 'trash_thread', 'untrash_message', 'untrash_thread'
    ) | ForEach-Object { "mcp__claude_ai_Gmail__$_" }
} else {
    # combined: reads the three data files, writes only into trips.tmp\, no Gmail at all, no shell
    $Allowed += 'Edit(trips.tmp/**)'
    $Denied = @('mcp__claude_ai_Gmail')
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
$runStart = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $Culture)

if (-not (Test-Path -LiteralPath $LogCsv) -or (Get-Item -LiteralPath $LogCsv).Length -eq 0) {
    [System.IO.File]::WriteAllText($LogCsv, "run_date,success,changed,type`r`n", $Utf8)
}

$beforeRaw = $null
$before = $null
$snapBefore = $null
$dataPath = $null
if ($Job -eq 'combined') {
    $snapBefore = Get-JsonSnapshot $TripsDir
    if (Test-Path -LiteralPath $TripsTmp) { Remove-Item -LiteralPath $TripsTmp -Recurse -Force }
    New-Item -ItemType Directory -Path $TripsTmp | Out-Null
} else {
    $dataPath = Join-Path $Root $Cfg.Data
    if (Test-Path -LiteralPath $dataPath) { $beforeRaw = [System.IO.File]::ReadAllText($dataPath, $Utf8) }
    $before = Read-SourceText $beforeRaw $Cfg
    if ($null -ne $beforeRaw) { [System.IO.File]::WriteAllText((Join-Path $Root "$($Cfg.Base).backup.json"), $beforeRaw, $Utf8) }
    $leftover = Join-Path $Root "$($Cfg.Base).tmp.json"
    if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Force }
}

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }

$reason   = ''
$timedOut = $false
$exit     = -1
$stdout   = ''
$stderr   = ''

try {
    if (-not (Test-Path -LiteralPath $claude)) { throw "claude CLI not found ($claude)" }
    if (-not (Test-Path -LiteralPath $PromptFile)) { throw "$($Cfg.Prompt) not found" }

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

    if (-not $p.WaitForExit($Cfg.TimeoutMin * 60000)) {
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
# Judge the result
# ---------------------------------------------------------------------------
$success = $false
$changed = $false

if (-not $reason) {
    if ($timedOut) { $reason = "timed out after $($Cfg.TimeoutMin) min" }
    elseif ($exit -ne 0) { $reason = "claude exited with code $exit" }
    elseif ($Cfg.Gmail -and $stdout -match '(?m)^\s*ERROR:\s*Gmail unavailable') { $reason = 'Gmail unavailable' }
    elseif ($stdout -cmatch '(?m)^\s*ERROR:') { $reason = 'the run reported an error (see last-run file)' }  # case-sensitive: "Errors:" is a summary heading
}

if (-not $reason) {
    if ($Job -eq 'combined') {
        if ($stdout -match '(?m)^\s*SKIPPED:') {
            $success = $true
            $reason = 'skipped: no flight, hotel or transport changes today'
        } else {
            $problem = Test-TripsDir $TripsTmp $runStart
            if ($problem) {
                $reason = "trips.tmp failed validation: $problem"
            } else {
                try {
                    Publish-Trips
                    $after = Get-JsonSnapshot $TripsDir
                    $problem = Test-TripsDir $TripsDir ''
                    if ($problem) { throw $problem }
                    $success = $true
                    $changed = ($null -eq $snapBefore) -or ($snapBefore.Count -eq 0) -or ((Get-TripsSignature $snapBefore) -ne (Get-TripsSignature $after))
                } catch {
                    $reason = "publishing trips failed: $($_.Exception.Message)"
                }
            }
        }
    } else {
        $afterRaw = if (Test-Path -LiteralPath $dataPath) { [System.IO.File]::ReadAllText($dataPath, $Utf8) } else { $null }
        $after = Read-SourceText $afterRaw $Cfg
        if ($null -eq $after) { $reason = "$($Cfg.Data) missing or unparsable after run" }
        elseif ($after.Problem) { $reason = "$($Cfg.Data) failed schema check after run: $($after.Problem)" }
        elseif ($null -ne $before -and $after.RunDate -eq $before.RunDate) { $reason = 'runDate was not updated (nothing was scanned)' }
        elseif ($after.RunDate -lt $runStart) { $reason = "runDate $($after.RunDate) is older than this run's start" }
        else {
            $success = $true
            $changed = ($null -eq $before) -or ($after.DataJson -ne $before.DataJson)
        }
    }
}

if (-not $success) {
    # put back exactly what was there before the run
    if ($Job -eq 'combined') {
        try { Restore-Trips $snapBefore } catch { $reason += " (restore failed: $($_.Exception.Message))" }
    } elseif ($null -ne $beforeRaw) {
        [System.IO.File]::WriteAllText($dataPath, $beforeRaw, $Utf8)
    } elseif (Test-Path -LiteralPath $dataPath) {
        Remove-Item -LiteralPath $dataPath -Force
    }
}
if ($Job -eq 'combined' -and (Test-Path -LiteralPath $TripsTmp)) { Remove-Item -LiteralPath $TripsTmp -Recurse -Force }

# logo cache (flight job): done here so it does not depend on Claude's shell permissions (only downloads missing logos)
if ($success -and $Cfg.Logos) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($node) { try { & $node (Join-Path $Root 'scripts\fetch-logos.js') | Out-Null } catch { } }
}

$row = '{0},{1},{2},{3}' -f $runStart, $success.ToString().ToLower(), $changed.ToString().ToLower(), $Job
[System.IO.File]::AppendAllText($LogCsv, $row + "`r`n", $Utf8)

$report = @(
    "job      : $Job",
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
