# Lifeline agent installer (Windows x64).
#
# Downloads a platform runtime (bundled Node + CLI + better-sqlite3).
# No system Node required.
#
# Usage -- run it in PowerShell (not cmd), from your Lifeline server:
#   irm http://<your-lifeline-server>/public/install.ps1 | iex
# (The server rewrites the origin placeholder below to the origin you downloaded from;
#  $env:LIFELINE_SERVER always wins if you need to pin one.)
#
# ---------------------------------------------------------------------------
# Why this file is ASCII-only
# ---------------------------------------------------------------------------
# `irm ... | iex` executes this text inside the caller's session, and
# Invoke-RestMethod **decodes** the body according to the response charset.
# Measured on Windows PowerShell 5.1: with `application/octet-stream` (or
# `text/plain` without a charset) the body is decoded as Latin-1, so any
# non-ASCII byte here turns into mojibake in exactly the messages the user needs
# when something fails. Our server does send `.ps1` as
# `text/plain; charset=utf-8` (packages/server/src/http.ts), so Chinese would
# work today -- but an installer must not print garbage at the moment it fails,
# and it can also be fetched from a plain static host or through a proxy that
# rewrites Content-Type. ASCII is the one spelling that is correct on every
# delivery path.
#
# (For the record: the other consumer -- `lifeline update` piping this script
# into `powershell -Command -` -- decodes UTF-8 stdin correctly, so that path is
# not the constraint; `install.sh` is unaffected either way because curl hands
# the shell raw bytes.)
#
# The Chinese guidance lives in the web UI instead.
#
# ---------------------------------------------------------------------------
# Windows PowerShell 5.1 constraints (the scheduled task always runs 5.1)
# ---------------------------------------------------------------------------
# - no C-style command chaining (that operator arrived in PowerShell 7)
# - no null-coalescing, null-conditional or ternary operators
# - the path-join cmdlet takes exactly two positional arguments
# - text writes default to UTF-16 here, so we always pass -Encoding ASCII
# ---------------------------------------------------------------------------

function Install-Lifeline {
  # Function scope: neither preference leaks into the caller's session
  # (`irm | iex` would otherwise leave the user's shell with Stop semantics).
  $ErrorActionPreference = 'Stop'
  # 5.1's progress bar makes Invoke-WebRequest roughly ten times slower.
  $ProgressPreference = 'SilentlyContinue'

  $taskName = 'Lifeline Agent'
  $package = 'lifeline-win32-x64.zip'

  $base = '__SERVER_ORIGIN__'
  if ($env:LIFELINE_SERVER) { $base = $env:LIFELINE_SERVER }
  $base = $base.TrimEnd('/')

  $libDir = Join-Path $env:USERPROFILE '.lifeline'
  if ($env:LIFELINE_HOME) { $libDir = $env:LIFELINE_HOME }
  $binDir = Join-Path $libDir 'bin'
  if ($env:LIFELINE_BIN_DIR) { $binDir = $env:LIFELINE_BIN_DIR }

  $runtimeDir = Join-Path $libDir 'runtime'
  $nextDir = Join-Path $libDir 'runtime.next'
  $oldDir = Join-Path $libDir 'runtime.old'
  $mjsPath = Join-Path $runtimeDir 'lifeline.mjs'

  $tmp = $null

  function Fail([string]$message) {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    # Write the reason on stderr FIRST. Measured with `powershell -Command -` (how
    # `lifeline update` runs this file): a failure inside the installer produced NO
    # stderr at all and exit code 0 -- the user was left staring at
    # "Downloading from ..." with nothing after it. The CLI does not trust that exit
    # code either (it re-runs the installed bundle to prove the swap); this line is
    # so a human can see why.
    [Console]::Error.WriteLine($message)
    # Deliberately NOT `exit`: under `irm | iex` that would close the user's
    # PowerShell window.
    throw $message
  }

  # Served straight from the repo (placeholder not rewritten) -> refuse instead of
  # guessing a server. Must sit below function Fail (PS defines-then-calls).
  # The comparison literal is deliberately split in two: the server's rewrite is a
  # global replace, and a single-piece literal would get rewritten too, making
  # "$base -eq <real origin>" always true and tripping the guard on every
  # correctly-served script.
  if ($base -eq ('__SERVER_ORIGIN' + '__')) {
    Fail "This script was not served by a Lifeline server (its origin placeholder was not rewritten). Download it from your server, e.g. irm http://<your-lifeline-server>/public/install.ps1 | iex, or set LIFELINE_SERVER."
  }

  function Get-Url([string]$url, [string]$dest) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest
  }

  function Stop-DaemonQuiet {
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
  }

  function Start-DaemonQuiet {
    try { Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
  }

  # Normalise PATH entries before comparing them: a literal compare treats
  # `...\bin` and `...\bin\` as two different entries, so we would append a second
  # copy instead of recognising the one already present. uninstall.ps1 carries the
  # same helper (there the failure mode is a silent no-op removal).
  function NormalizePath([string]$value) {
    if (-not $value) { return '' }
    $trimmed = $value.Trim().TrimEnd('\')
    try { return [System.IO.Path]::GetFullPath($trimmed) } catch { return $trimmed }
  }

  Write-Host ''
  Write-Host 'Lifeline install (Windows x64)'
  Write-Host ''

  # --- platform -------------------------------------------------------------
  # A 32-bit PowerShell on 64-bit Windows reports x86 here while
  # PROCESSOR_ARCHITEW6432 still says AMD64 -- checking only the first one would
  # reject a perfectly good x64 box.
  $arch = $env:PROCESSOR_ARCHITECTURE
  $archWow = $env:PROCESSOR_ARCHITEW6432
  if (($arch -eq 'ARM64') -or ($archWow -eq 'ARM64')) {
    Fail ('Unsupported architecture: Windows arm64 is not supported yet. Detected: ' + $arch)
  }
  if (($arch -ne 'AMD64') -and ($archWow -ne 'AMD64')) {
    Fail ('Unsupported architecture (need Windows x64). Detected: ' + $arch + ' / ' + $archWow)
  }

  # Read this before we touch anything: it decides what we print at the end.
  $wasInstalled = Test-Path -LiteralPath $mjsPath

  # --- download -------------------------------------------------------------
  $tempRoot = [System.IO.Path]::GetTempPath()
  $stamp = [Guid]::NewGuid().ToString('N')
  $tmpName = 'lifeline-install-' + $stamp
  $tmp = Join-Path $tempRoot $tmpName
  [System.IO.Directory]::CreateDirectory($tmp) | Out-Null
  $shaName = $package + '.sha256'
  $zipPath = Join-Path $tmp $package
  $shaPath = Join-Path $tmp $shaName

  $zipUrl = $base + '/public/' + $package
  $shaUrl = $zipUrl + '.sha256'

  Write-Host ('Downloading from ' + $base + ' ...')
  try {
    Get-Url $zipUrl $zipPath
  } catch {
    if ($base.StartsWith('https://')) {
      # Some hosts reset 443 mid-handshake: retry over http.
      # The sha256 check below still guarantees integrity.
      $base = 'http://' + $base.Substring(8)
      Write-Host ('Note: https did not work (443 blocked?), retrying over ' + $base)
      $zipUrl = $base + '/public/' + $package
      $shaUrl = $zipUrl + '.sha256'
      Get-Url $zipUrl $zipPath
    } else {
      Fail ('Download failed: ' + $zipUrl)
    }
  }
  try {
    Get-Url $shaUrl $shaPath
  } catch {
    Fail ('Download failed: ' + $shaUrl)
  }

  # --- verify ---------------------------------------------------------------
  $shaText = Get-Content -LiteralPath $shaPath -Raw
  # Shape check first: an SSO login page served with HTTP 200 looks nothing like
  # a sha256 manifest, and its own hash would never match.
  $match = [regex]::Match($shaText, '(?im)^\s*([a-f0-9]{64})\s{2}')
  if (-not $match.Success) {
    Fail ('The checksum file is not a sha256 manifest (login page in the way?): ' + $shaUrl)
  }
  $expected = $match.Groups[1].Value.ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    Fail 'sha256 mismatch -- the existing install was left untouched'
  }

  # --- extract --------------------------------------------------------------
  if (Test-Path -LiteralPath $nextDir) {
    Remove-Item -LiteralPath $nextDir -Recurse -Force
  }
  [System.IO.Directory]::CreateDirectory($nextDir) | Out-Null

  $tarCmd = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tarCmd) {
    & $tarCmd.Source -xf $zipPath -C $nextDir
  } else {
    # tar.exe only exists from Windows 10 1803 on. Use -LiteralPath rather than
    # its sibling wildcard form: brackets in LIFELINE_HOME would be treated as a
    # character class and the archive would silently not be found.
    Expand-Archive -LiteralPath $zipPath -DestinationPath $nextDir -Force
  }

  $nextNode = Join-Path $nextDir 'node.exe'
  $nextMjs = Join-Path $nextDir 'lifeline.mjs'
  if ((-not (Test-Path -LiteralPath $nextNode)) -or (-not (Test-Path -LiteralPath $nextMjs))) {
    Remove-Item -LiteralPath $nextDir -Recurse -Force -ErrorAction SilentlyContinue
    Fail 'Extraction failed -- the existing install was left untouched'
  }

  # --- swap (Windows file locks) --------------------------------------------
  # A running node.exe cannot be deleted (Access denied), but it CAN be renamed,
  # so: stop daemon -> rename runtime to runtime.old -> move runtime.next into
  # place -> start daemon -> delete runtime.old.
  if (Test-Path -LiteralPath $runtimeDir) {
    Stop-DaemonQuiet
    # Sweep leftovers from earlier upgrades: both the plain runtime.old and any
    # runtime.old.<stamp> we had to move aside because a process still held it.
    # A locked directory survives the delete (it is in use) and gets renamed
    # aside again below, so these cannot pile up run after run.
    $leftovers = @(Get-ChildItem -LiteralPath $libDir -Directory -Filter 'runtime.old*' -ErrorAction SilentlyContinue)
    foreach ($leftover in $leftovers) {
      Remove-Item -LiteralPath $leftover.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $oldDir) {
      # Still held: a process is running from it (a leftover agent, or a
      # foreground `lifeline start`). Renaming onto it would fail, and failing
      # the whole upgrade because of stale cruft would be worse -- so move it
      # aside under a unique name and carry on. uninstall.ps1 cleans runtime.old*.
      $asideName = 'runtime.old.' + $stamp
      Rename-Item -LiteralPath $oldDir -NewName $asideName
      Write-Host ('Note: ' + $oldDir + ' was still locked; moved it aside to ' + $asideName)
    }

    Rename-Item -LiteralPath $runtimeDir -NewName 'runtime.old'
    try {
      Move-Item -LiteralPath $nextDir -Destination $runtimeDir
    } catch {
      # Roll back. Without this the CLI would dangle -- runtime has been renamed
      # away but the new one never landed -- and `lifeline` would be broken with
      # no obvious cause. Both paths below restart the daemon and report why:
      # leaving the daemon stopped with a raw rename error would be the worst
      # possible outcome.
      $detail = $_.Exception.Message
      if (Test-Path -LiteralPath $runtimeDir) {
        Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction SilentlyContinue
      }
      if (Test-Path -LiteralPath $runtimeDir) {
        Start-DaemonQuiet
        Fail ('Cannot move the new runtime into place: ' + $detail + ' -- the previous runtime is still at ' + $oldDir)
      }
      Rename-Item -LiteralPath $oldDir -NewName 'runtime'
      Start-DaemonQuiet
      Fail ('Cannot move the new runtime into place: ' + $detail)
    }
    Start-DaemonQuiet

    # Best effort: if a file is still held we leave it; the sweep above retries.
    Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    # Fresh install: nothing to swap.
    Move-Item -LiteralPath $nextDir -Destination $runtimeDir
    Start-DaemonQuiet
  }

  # --- CLI shim -------------------------------------------------------------
  [System.IO.Directory]::CreateDirectory($binDir) | Out-Null
  $shimPath = Join-Path $binDir 'lifeline.cmd'
  # %~dp0 already ends with a backslash, so `..\runtime` is the sibling of bin\.
  # ASCII so that a 5.1 text write cannot emit UTF-16.
  Set-Content -LiteralPath $shimPath -Encoding ASCII -Value @(
    '@echo off',
    '"%~dp0..\runtime\node.exe" "%~dp0..\runtime\lifeline.mjs" %*'
  )
  Write-Host ('Installed: ' + $shimPath)

  # --- PATH (User scope only) ----------------------------------------------
  # Never write $env:Path (User + Machine joined) back into the User slot: that
  # would copy every Machine entry into the user's variable. Never pass $null to
  # SetEnvironmentVariable either -- that DELETES the variable.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $userPath) { $userPath = '' }
  $entries = @($userPath.Split(';') | Where-Object { $_ -ne '' })
  $wantBin = NormalizePath($binDir)
  $alreadyThere = @($entries | Where-Object { (NormalizePath $_) -eq $wantBin })
  if ($alreadyThere.Count -eq 0) {
    $joined = (@($entries) + $binDir) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
  }
  $sessionAlready = @($env:Path.Split(';') | Where-Object { (NormalizePath $_) -eq $wantBin })
  if ($sessionAlready.Count -eq 0) {
    $env:Path = $env:Path + ';' + $binDir
  }

  # --- report ---------------------------------------------------------------
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  $tmp = $null

  Write-Host ''
  if ($wasInstalled) {
    Write-Host ('Updated: ' + $mjsPath)
    Write-Host 'Restart the background agent so it runs the new version:'
    Write-Host '  lifeline daemon install'
  } else {
    Write-Host 'Next, sign in (opens a browser; no token to type):'
    Write-Host ('  lifeline setup --server-url ' + $base)
    Write-Host ''
    Write-Host 'Run that in PowerShell (not cmd).'
    Write-Host ''
    Write-Host 'If Cursor or CodeBuddy is running, lifeline restarts it with a debug port.'
    Write-Host ''
    Write-Host 'To uninstall later:'
    Write-Host ('  irm ' + $base + '/public/uninstall.ps1 | iex')
  }
  Write-Host ''
}

# `lifeline update` pipes THIS FILE into `powershell -Command -`, which consumes
# stdin statement by statement: a throw inside Install-Lifeline therefore aborts
# only that one statement, and the cleanup below still runs. Re-raising at the very
# end keeps the exit code meaningful in that shape.
#
# It is a best-effort signal, NOT the contract: measured on this host, a failed
# download produced exit code 0 anyway. `lifeline update` therefore decides success
# by re-running the installed bundle (see cmdUpdate in packages/cli/src/index.ts),
# and Fail() writes the reason to stderr so the failure is at least visible.
# We deliberately do NOT use `exit` -- under `irm | iex` that closes the user's
# PowerShell window.
$installFailed = $false
try {
  Install-Lifeline
} catch {
  $installFailed = $true
}

# Do not leave the function sitting in the caller's session (`irm | iex` runs in
# the current scope). Best effort.
Remove-Item function:Install-Lifeline -ErrorAction SilentlyContinue

if ($installFailed) {
  throw 'lifeline install did not complete -- the existing runtime was left in place'
}
