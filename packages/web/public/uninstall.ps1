# Lifeline agent uninstaller (Windows).
#
# Removes the local agent: scheduled task, surviving agent processes, the managed
# CDP argv we wrote into Cursor / CodeBuddy, the config home, the CLI shim, the
# User PATH entry, and an npm-global lifeline if there is one.
#
# Usage -- run it in PowerShell (not cmd), from your Lifeline server:
#   irm http://<your-lifeline-server>/public/uninstall.ps1 | iex
#
# Same conventions as install.ps1 (see its header for the full reasoning):
# - ASCII body: `irm | iex` decodes the body per the response charset, and this
#   report must stay readable on every delivery path.
# - Windows PowerShell 5.1 only syntax (no C-style chaining, no null-coalescing /
#   null-conditional / ternary, the path-join cmdlet takes two positional args).
# - Everything inside a function and no `exit`: `irm | iex` runs in the caller's
#   session, and an exit there would close the user's PowerShell window.
# - Cleanup keeps going after failures ($ErrorActionPreference stays Continue):
#   a half-removed install is worse than a report that lists what refused to go.
# ---------------------------------------------------------------------------

function Uninstall-Lifeline {
  $ErrorActionPreference = 'Continue'
  $ProgressPreference = 'SilentlyContinue'

  $taskName = 'Lifeline Agent'

  $libDir = Join-Path $env:USERPROFILE '.lifeline'
  if ($env:LIFELINE_HOME) { $libDir = $env:LIFELINE_HOME }
  $binDir = Join-Path $libDir 'bin'
  if ($env:LIFELINE_BIN_DIR) { $binDir = $env:LIFELINE_BIN_DIR }

  # Hashtable so the helper below can flip the flag across scopes.
  $state = @{ removedAny = $false }

  function Row([string]$label, [string]$value) {
    Write-Host ('  ' + $label.PadRight(10) + ' ' + $value)
    $state.removedAny = $true
  }

  # Normalise PATH entries before comparing them: a literal compare treats
  # `...\bin` and `...\bin\` as two different entries, so the removal becomes a
  # silent no-op -- we would not even print the `path` row -- and the stale entry
  # stays behind. Note: GetFullPath does NOT fold an 8.3 short name (`ADMINI~1`)
  # into `Administrator`; install and uninstall derive $binDir from the same
  # `$env:USERPROFILE`, so in practice both sides agree.
  function NormalizePath([string]$value) {
    if (-not $value) { return '' }
    $trimmed = $value.Trim().TrimEnd('\')
    try { return [System.IO.Path]::GetFullPath($trimmed) } catch { return $trimmed }
  }

  Write-Host ''
  Write-Host 'Lifeline uninstall (Windows)'
  Write-Host ''

  # --- scheduled task -------------------------------------------------------
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
    try {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
      Row 'daemon' 'unregistered the scheduled task'
    } catch {
      Row 'daemon' ('could not unregister the task: ' + $_.Exception.Message)
    }
  } else {
    # Degraded install (no scheduled task): fall back to the pidfile.
    $pidFile = Join-Path $libDir 'daemon.pid'
    if (Test-Path -LiteralPath $pidFile) {
      $daemonPid = 0
      $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
      [void][int]::TryParse($raw, [ref]$daemonPid)
      # A stale pidfile can point at something unrelated -- Windows reuses PIDs
      # aggressively -- so never kill the number blindly: confirm it is our agent.
      $target = $null
      try {
        $target = Get-CimInstance Win32_Process -Filter "ProcessId = $daemonPid" -ErrorAction SilentlyContinue
      } catch { }
      $isOurs = $target -and ($target.Name -eq 'node.exe') -and ($target.CommandLine -like '*runtime\lifeline.mjs*')
      if ($isOurs) {
        try { Stop-Process -Id $daemonPid -ErrorAction SilentlyContinue } catch { }
        Start-Sleep -Seconds 1
        try { Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue } catch { }
        Row 'daemon' ('stopped the background agent (pidfile ' + $daemonPid + ')')
      } elseif ($daemonPid -gt 1) {
        Row 'daemon' ('ignored a stale pidfile (' + $daemonPid + ' is not our agent)')
      }
    }
  }

  # --- surviving agent processes -------------------------------------------
  # A task stop only asks; an agent stuck in shutdown survives it, and its
  # runtime directory is about to be deleted -- so collect the leftovers here.
  #
  # The only two places we force-kill are **our own agent processes** (here and
  # the pidfile branch above) -- never an arbitrary pid.
  #
  # NOTE for the `lifeline stop` implementation: do NOT copy this matcher.
  # A foreground `lifeline start` has a byte-identical command line, so this
  # "everything that looks like our agent" sweep is only acceptable because
  # uninstall removes the whole install. `stop` must narrow it to processes whose
  # ParentProcessId is no longer in the process table (see the plan, section 11).
  $orphans = @()
  try {
    $orphans = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -like '*runtime\lifeline.mjs*') })
  } catch { }
  if ($orphans.Count -gt 0) {
    foreach ($proc in $orphans) {
      try { Stop-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Seconds 1
    foreach ($proc in $orphans) {
      try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
    Row 'agent' ('stopped ' + $orphans.Count + ' orphaned process(es)')
  }

  # --- managed CDP argv -----------------------------------------------------
  # Only the lines we wrote: they carry the `Lifeline CDP` marker. Anything else
  # in the file belongs to the user and must survive untouched.
  # .NET IO (not Set-Content): PowerShell 5.1 writes UTF-8 *with* a BOM, and a BOM
  # in argv.json is exactly the kind of thing a JSON reader may reject.
  $appData = $env:APPDATA
  $cursorArgv = Join-Path $appData 'Cursor\argv.json'
  $buddyCnArgv = Join-Path $appData 'CodeBuddy CN\argv.json'
  $buddyArgv = Join-Path $appData 'CodeBuddy\argv.json'
  $argvFiles = @($cursorArgv, $buddyCnArgv, $buddyArgv)

  $stripped = 0
  foreach ($argvPath in $argvFiles) {
    if (-not (Test-Path -LiteralPath $argvPath)) { continue }
    try {
      $raw = [System.IO.File]::ReadAllText($argvPath, [System.Text.Encoding]::UTF8)
      # Also accept the legacy marker `AgentRemote CDP`: packages/cli/src/cdp-argv.ts
      # recognises both, and an install from that era could otherwise never be cleaned.
      $marker = '(Lifeline|AgentRemote) CDP'
      if ($raw -notmatch $marker) { continue }
      $kept = @($raw -split "`r?`n" | Where-Object {
        ($_ -notmatch $marker) -and ($_ -notmatch '"remote-debugging-port"\s*:')
      })
      $out = $kept -join "`r`n"
      $out = [regex]::Replace($out, ',(\s*\})', '$1')   # no dangling comma
      if (-not $out.EndsWith("`n")) { $out = $out + "`n" }
      [System.IO.File]::WriteAllText($argvPath, $out, (New-Object System.Text.UTF8Encoding($false)))
      $stripped = $stripped + 1
    } catch { }
  }
  if ($stripped -gt 0) {
    Row 'cdp argv' ('stripped remote-debugging-port from ' + $stripped + ' IDE file(s)')
  }

  # --- leftover runtime directories ----------------------------------------
  # install.ps1 moves a still-held runtime.old aside as runtime.old.<stamp>
  # (that is what keeps an upgrade from stalling on stale cruft). Clear them here
  # too -- a locked one would otherwise leave the home only half-deleted.
  $leftovers = @(Get-ChildItem -LiteralPath $libDir -Directory -Filter 'runtime.old*' -ErrorAction SilentlyContinue)
  foreach ($leftover in $leftovers) {
    Remove-Item -LiteralPath $leftover.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }

  # --- config home ----------------------------------------------------------
  if (Test-Path -LiteralPath $libDir) {
    Remove-Item -LiteralPath $libDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $libDir) {
      Row 'config' ('could not fully remove ' + $libDir + ' (still locked)')
    } else {
      Row 'config' ('removed ' + $libDir)
    }
  }

  # --- CLI shim -------------------------------------------------------------
  $shimPath = Join-Path $binDir 'lifeline.cmd'
  if (Test-Path -LiteralPath $shimPath) {
    Remove-Item -LiteralPath $shimPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $shimPath) {
      Row 'cli' ('could not remove ' + $shimPath)
    } else {
      Row 'cli' ('removed ' + $shimPath)
    }
  }

  # --- User PATH ------------------------------------------------------------
  # User slot only, and both sides are printed so the user can eyeball that no
  # other entry was touched. The comparison is exact (case-insensitive), never a
  # substring, and we never pass $null to SetEnvironmentVariable -- that would
  # DELETE the variable instead of emptying an entry.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath) { $userPath = '' }
  Write-Host ('  ' + 'PATH before'.PadRight(10) + ' ' + $userPath)
  $entries = @($userPath.Split(';') | Where-Object { $_ -ne '' })
  $wantBin = NormalizePath($binDir)
  $keptEntries = @($entries | Where-Object { (NormalizePath $_) -ne $wantBin })
  if ($keptEntries.Count -ne $entries.Count) {
    [Environment]::SetEnvironmentVariable('Path', ($keptEntries -join ';'), 'User')
    Row 'path' ('removed ' + $binDir)
  }
  $afterPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $afterPath) { $afterPath = '' }
  Write-Host ('  ' + 'PATH after'.PadRight(10) + ' ' + $afterPath)

  # --- npm-global CLI -------------------------------------------------------
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($npm) {
    try {
      & $npm.Source uninstall -g lifeline 2>&1 | Out-Null
      # `npm uninstall` exits 0 even when nothing was installed, so keep the wording
      # honest; a non-zero code means npm itself failed -- do not claim success.
      if ($LASTEXITCODE -eq 0) {
        Row 'npm' 'uninstalled the global lifeline package (if any)'
      } else {
        Row 'npm' ('npm uninstall exited with ' + $LASTEXITCODE)
      }
    } catch { }
  }

  # --- result ---------------------------------------------------------------
  Write-Host ''
  if (-not $state.removedAny) { Write-Host '  nothing to remove' }

  # `Get-Command lifeline` and not `where.exe` so this also works on PowerShell
  # hosts without that binary on PATH.
  $left = Get-Command lifeline -ErrorAction SilentlyContinue
  if ($left) {
    Write-Host ('  note       lifeline is still on PATH (' + $left.Source + '); remove it if setup keeps asking for a token')
  }
  Write-Host ''
}

Uninstall-Lifeline

# Same reason as install.ps1: do not leave the function in the caller's session.
Remove-Item function:Uninstall-Lifeline -ErrorAction SilentlyContinue
