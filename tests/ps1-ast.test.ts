import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = [
  join(ROOT, 'packages/web/public/install.ps1'),
  join(ROOT, 'packages/web/public/uninstall.ps1'),
];

/**
 * A PowerShell host available on Windows; on Linux/macOS this may be `pwsh`.
 *
 * If none is found, **skip and explain why** — do not silently pass. An always-green test is worse than no test.
 */
function findHost(): string | undefined {
  const candidates
    = process.platform === 'win32'
      ? [
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          'pwsh',
        ]
      : ['pwsh', 'powershell'];
  for (const c of candidates) {
    const r = spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 20_000 });
    if (!r.error && r.status === 0)
      return c;
  }
  return undefined;
}

/**
 * Validate scripts with PowerShell's own AST: **every named parameter must actually exist**.
 *
 * Why: text assertions only see strings; `New-Item -LiteralPath` is **perfectly legal text**,
 * but `New-Item` has no such parameter — that class of error only blows up on the user's
 * machine (Task 9 hit this live: `A parameter cannot be found that matches parameter name 'LiteralPath'`).
 *
 * Commands whose name cannot be resolved: only report **simple identifiers** (those are typo'd
 * cmdlets); skip dotted ones (method calls like `[System.IO.Directory]`); skip functions defined in the script.
 */
function validationScript(files: string[]): string {
  // PowerShell arrays are @('a','b'): injecting JSON `[...]` would be parsed as a type literal.
  const list = files.map(f => `'${f.replace(/'/g, '\'\'')}'`).join(',');
  // Function names defined in the script are collected on the JS side and injected.
  // Tried collecting with FindAll(FunctionDefinitionAst) in PS, but `$defined` never applied
  // to `Fail` / `Get-Url` (while `Stop-DaemonQuiet` etc. did); not worth digging PS scope
  // for a test helper. A line-anchored regex is unambiguous: PS function defs are always
  // `function Name` at the start of a line (indent allowed).
  const defined = definedFunctionNames(files)
    .map(n => `'${n.replace(/'/g, '\'\'')}'`)
    .join(',');
  return `
# Pitfall we hit in practice: PowerShell spawned from node inherits a
# PSModulePath that ranks **PowerShell 7** module dirs ahead of 5.1, so 5.1
# loads PS7 modules and **resolves nothing** (even Get-FileHash is unknown;
# Get-Module -ListAvailable shows 2 candidates). Point PSModulePath back at
# 5.1's own Modules directory.
$env:PSModulePath = (Join-Path $PSHOME 'Modules')
Import-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue
Import-Module Microsoft.PowerShell.Management -ErrorAction SilentlyContinue
Import-Module Microsoft.PowerShell.Archive -ErrorAction SilentlyContinue
Import-Module CimCmdlets -ErrorAction SilentlyContinue
Import-Module ScheduledTasks -ErrorAction SilentlyContinue

$files = @(${list})
$defined = @(${defined})
$unresolved = 0
$errors = New-Object System.Collections.ArrayList
foreach ($f in $files) {
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$parseErrors)
  foreach ($pe in $parseErrors) {
    [void]$errors.Add($f + ': parse error: ' + $pe.Message)
  }
  $cmds = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
  foreach ($c in $cmds) {
    $name = $c.GetCommandName()
    if (-not $name) { continue }
    if ($defined -contains $name) { continue }
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
      # ScheduledTasks / CimCmdlets are Windows-only: on a Linux/macOS pwsh host they
      # simply do not exist, so reporting them as typos would fail this check for a
      # reason that has nothing to do with our scripts. Count them instead and say so.
      if (($env:OS -eq 'Windows_NT') -and ($name -match '^[A-Za-z][A-Za-z0-9-]*$')) {
        [void]$errors.Add($f + ': unknown command: ' + $name)
      } else {
        $unresolved = $unresolved + 1
      }
      continue
    }
    if (-not $cmd.Parameters) { continue }
    foreach ($e in $c.CommandElements) {
      if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
        if (-not $cmd.Parameters.ContainsKey($e.ParameterName)) {
          [void]$errors.Add($f + ': ' + $name + ' has no parameter -' + $e.ParameterName)
        }
      }
    }
  }
}
if ($errors.Count -gt 0) {
  foreach ($e in $errors) { Write-Output $e }
  exit 1
}
if ($unresolved -gt 0) {
  Write-Output ('NOTE: ' + $unresolved + ' command(s) could not be resolved on this host and were not parameter-checked')
}
Write-Output 'AST-OK'
`;
}

/** Write the validator to a temp file and run it with `-File` (see the comment below on why not stdin / -EncodedCommand). */
function runValidator(host: string, files: string[]): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ps1-ast-'));
  const file = join(dir, 'validate.ps1');
  try {
    // ⚠️ **Must have a BOM**: the script contains Chinese comments (see the note above this function),
    // and 5.1 `-File` reads **BOM-less** files as system ANSI (Chinese Windows = GBK) → those
    // comment/`Import-Module` lines are corrupted → `Get-FileHash` cannot be resolved →
    // `install.ps1: unknown command: Get-FileHash` (the on-machine "red depending on mood",
    // same pit as daemon.ps1 needing a BOM).
    writeFileSync(file, `\uFEFF${validationScript(files)}`, 'utf8');
    const r = spawnSync(
      host,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout: 60_000 },
    );
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Function names defined in the script (PS function defs are always `function Name` at line start, indent allowed). */
function definedFunctionNames(files: string[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/^[ \t]*function[ \t]+([A-Za-z][\w-]*)/gm)) {
      names.add(m[1]!);
    }
  }
  return [...names];
}

const host = findHost();
const skip = !host && 'no PowerShell host (powershell.exe / pwsh) on this machine';

/** Generated scripts must pass the same ruler: they are runtime `.ps1` files and hit the same cmdlet-parameter pits. */
async function generatedScripts(dir: string): Promise<string[]> {
  const { windowsDaemonScript } = await import('../packages/cli/src/win-daemon.js');
  const file = join(dir, 'daemon.generated.ps1');
  writeFileSync(file, windowsDaemonScript('C:\\h\\.lifeline\\runtime\\node.exe', 'C:\\h\\.lifeline\\runtime\\lifeline.mjs'), 'utf8');
  return [file];
}

describe('install scripts (PowerShell AST)', () => {
  it('both scripts exist', () => {
    for (const f of SCRIPTS) assert.equal(existsSync(f), true, `${f} 不存在`);
  });

  /**
   * **Generated scripts** must be validated too.
   *
   * Why: `windowsDaemonScript()` produces a real `.ps1` (run by the scheduled task `-File`),
   * and it hits the same pits as handwritten ones — T12 on a live machine died on
   * `New-Item -LiteralPath` (`New-Item` has no such parameter → log dir never created →
   * redirect fails → agent never launched), while every test was green. Handwritten scripts
   * had AST checks, generated ones did not: that was the gap.
   */
  /**
   * **Inline statements** (one-line PowerShell from `windowsRegisterPsCommand()` etc.) must pass this ruler too.
   *
   * ⚠️ **Capability bound (confirmed live; do not treat this as a panacea)**: this checker only
   * asks whether **parameters that appeared** exist on that cmdlet. It **does not check missing
   * mandatory parameters** — that is runtime binding, unavailable at parse time.
   * Measured: deleting `-UserId (...)` from `windowsRegisterPsCommand` still **leaves this case
   * green** (typoing `-LogonType` as `-LogonTypeTypo` is what turns it red).
   *
   * So the "mandatory missing → whole statement fails → task never registered" pit for `-UserId`
   * is **only** held by the `/New-ScheduledTaskPrincipal -UserId/` regex in
   * `tests/win-daemon.test.ts` — **do not delete it**; it looks tautological, it is that pit's
   * only guard.
   *
   * Auto-checking mandatory params would mean reimplementing PowerShell parameter-set binding
   * (`$cmd.Parameters` merges **all** sets; `Register-ScheduledTask`'s `-Xml` set would
   * immediately false-positive). Cost does not match benefit.
   */
  it('the inline daemon statements have no unknown parameters', { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps1-inline-'));
    try {
      const {
        windowsAgentProbePsCommand,
        windowsRegisterPsCommand,
        windowsStatusPsCommand,
        windowsStopPsCommand,
        windowsUnregisterPsCommand,
      } = await import('../packages/cli/src/win-daemon.js');
      const statements: Record<string, string> = {
        register: windowsRegisterPsCommand({ scriptPath: 'C:\\h\\.lifeline\\daemon.ps1' }),
        status: windowsStatusPsCommand(),
        stop: windowsStopPsCommand(),
        unregister: windowsUnregisterPsCommand(),
        // install read-back check (`Get-CimInstance` / `Where-Object` both pass the ruler here)
        probe: windowsAgentProbePsCommand(),
      };
      const files = Object.entries(statements).map(([name, statement]) => {
        const file = join(dir, `${name}.ps1`);
        writeFileSync(file, `${statement}\n`, 'utf8');
        return file;
      });
      const r = runValidator(host!, files);
      assert.equal(r.status, 0, `内联语句 AST 校验失败：\n${r.out}`);
      assert.match(r.out, /AST-OK/);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the generated daemon script passes the same check', { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps1-gen-'));
    try {
      const r = runValidator(host!, await generatedScripts(dir));
      assert.equal(r.status, 0, `生成脚本 AST 校验失败：\n${r.out}`);
      assert.match(r.out, /AST-OK/);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Self-check: prove this validator **actually reports errors**, not an always-green test.
  // Uses the exact parameter error Task 9 hit on a live machine.
  it('the validator itself flags a bogus parameter', { skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps1-bad-'));
    const bad = join(dir, 'bad.ps1');
    try {
      writeFileSync(bad, 'New-Item -ItemType Directory -LiteralPath x | Out-Null\n', 'utf8');
      const r = runValidator(host!, [bad]);
      assert.equal(r.status, 1, `应该报错，实际：\n${r.out}`);
      assert.match(r.out, /New-Item has no parameter -LiteralPath/);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every named parameter exists on the cmdlet that is being called', { skip }, () => {
    // Via a temp .ps1 + `-File`. Other delivery methods that were tried all have pits:
    //   - multiline script via stdin (`-Command -`) → ParserError
    //   - `-EncodedCommand` → even Import-Module cannot rescue module resolution
    //   - raw `-Command <multiline string>` → quotes/newlines uncontrollable
    const r = runValidator(host!, SCRIPTS);
    assert.equal(r.status, 0, `AST 校验失败：\n${r.out}`);
    assert.match(r.out, /AST-OK/);
  });

  it('scripts are ASCII (see install.ps1 header for why)', () => {
    for (const f of SCRIPTS) {
      const text = readFileSync(f, 'utf8');
      assert.doesNotMatch(text, /[^\x00-\x7F]/, `${f} 必须纯 ASCII`);
    }
  });
});
