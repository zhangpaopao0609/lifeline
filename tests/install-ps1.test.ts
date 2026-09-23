import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { joinPathArityViolations } from './ps1-helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'packages/web/public/install.ps1');
const text = (): string => readFileSync(SCRIPT, 'utf-8');

// Text assertions only: this script can only really run on Windows (on-machine e2e is planned Task 9 Step 4).
// What we pin are the points "you cannot see by reading the code; a mistake only blows up on the user's machine".
describe('install.ps1', () => {
  it('exists and is shipped by the web build', () => {
    assert.equal(existsSync(SCRIPT), true);
    // Source of truth has moved into FILES in `scripts/copy-web-public.ts` (the `build` script's
    // old POSIX `mkdir -p && cp && rm -rf` chain cannot run on Windows; see that script's header).
    // When changing assertions, watch the **new source of truth**, not package.json strings.
    const pkg = readFileSync(join(ROOT, 'packages/web/package.json'), 'utf-8');
    assert.match(pkg, /copy-web-public/, 'build 必须调用那个跨平台拷贝脚本');
    const copier = readFileSync(join(ROOT, 'scripts/copy-web-public.ts'), 'utf-8');
    assert.match(copier, /'install\.ps1'/);
  });

  // Measured (PS 5.1, same body fed three Content-Types):
  //   octet-stream   -> irm|iex runs, but the body is **decoded as Latin-1**, non-ASCII becomes mojibake
  //   text/plain     -> same (no charset)
  //   charset=utf-8  -> fine
  // The server is ours (Fastify + a hand-written trySendFile MIME table, see packages/server/src/http.ts),
  // and **already** serves `.ps1` as `text/plain; charset=utf-8` (added this round), so Chinese would work.
  // The remaining reason to insist on ASCII: the script may still come from a static host / a proxy
  // that rewrites Content-Type, and the installer must not print mojibake at **the moment of failure**
  // — ASCII is correct on every delivery path.
  // (install.sh is unaffected: curl passes bytes, the shell does not decode.)
  it('keeps the body ASCII so `irm | iex` cannot mojibake its messages', () => {
    assert.doesNotMatch(text(), /[^\x00-\x7F]/, 'install.ps1 必须纯 ASCII');
  });

  it('only targets Windows x64 (a 32-bit shell on x64 must not be rejected)', () => {
    const src = text();
    assert.match(src, /PROCESSOR_ARCHITECTURE/);
    // 32-bit PowerShell on a 64-bit system reports x86 — looking only at PROCESSOR_ARCHITECTURE would reject a real x64 machine
    assert.match(src, /PROCESSOR_ARCHITEW6432/);
    assert.match(src, /AMD64/);
    assert.match(src, /win32-x64/);
    assert.match(src, /ARM64/);
    assert.match(src, /Unsupported/);
  });

  // This script is written for Windows PowerShell 5.1 (the scheduled task always uses it)
  it('avoids PowerShell 7 only syntax', () => {
    const src = text();
    assert.doesNotMatch(src, /&&/, '5.1 没有 &&');
    assert.doesNotMatch(src, /\?\?/, '5.1 没有 ??');
    assert.doesNotMatch(src, /\?\./, '5.1 没有 ?.');
    // Line-by-line + quote/paren aware: `\s` false-positives across lines, and the space in `'CodeBuddy CN\x'` is not a parameter separator
    assert.deepEqual(joinPathArityViolations(src), [], '5.1 的 Join-Path 只吃两个位置参数');
  });

  it('downloads fast and writes bytes, not UTF-16 text', () => {
    const src = text();
    // 5.1's progress bar makes Invoke-WebRequest 10× slower
    assert.match(src, /\$ProgressPreference\s*=\s*'SilentlyContinue'/);
    assert.match(src, /-UseBasicParsing/);
    assert.match(src, /-OutFile/);
    assert.doesNotMatch(src, /Out-File/, '5.1 的 Out-File 默认 UTF-16，会把二进制写坏');
  });

  it('verifies sha256 and refuses to touch the old runtime on mismatch', () => {
    const src = text();
    assert.match(src, /Get-FileHash/);
    assert.match(src, /SHA256/);
    // Validate sidecar shape first: login-page HTML posing as sha256 must report "intercepted by login page", not be compared as a hash
    assert.match(src, /\[a-f0-9\]\{64\}/);
    assert.match(src, /login page/);
    assert.match(src, /sha256 mismatch/);
    assert.match(src, /left untouched/);
  });

  it('extracts with tar.exe and falls back to Expand-Archive -LiteralPath', () => {
    const src = text();
    assert.match(src, /tar\.exe/, 'Win10 1803+ 自带 tar.exe，优先用它');
    assert.match(src, /Get-Command\s+tar\.exe/);
    // Win10 before 1803 has no tar.exe — a fallback is required, and it **must use -LiteralPath**
    assert.match(src, /Expand-Archive\s+-LiteralPath/);
    assert.doesNotMatch(src, /Expand-Archive\s+-Path/, '-Path 会把 [] 当通配符');
    assert.match(src, /node\.exe/);
    assert.match(src, /lifeline\.mjs/);
    assert.match(src, /runtime\.next/);
  });

  // A running node.exe cannot be deleted on Windows (Access denied) — must rename around it
  it('replaces the runtime by rename, never by deleting a locked node.exe', () => {
    const src = text();
    assert.match(src, /runtime\.old/);
    assert.match(src, /Rename-Item/);
    assert.doesNotMatch(
      src,
      /Remove-Item[^\n]*\$runtimeDir[^\n]*\n[^\n]*Move-Item/,
      '不许"先删 runtime 再搬 runtime.next"',
    );
  });

  it('stops the daemon before swapping and starts it again afterwards', () => {
    const src = text();
    assert.match(src, /Stop-ScheduledTask/);
    assert.match(src, /Start-ScheduledTask/);
    assert.match(src, /Lifeline Agent/);
  });

  // The order itself is the file-lock scheme: stop the daemon before renaming, rename before
  // moving the new tree in, restart only after the move. Wrong order leaves a half-state of
  // "runtime gone, CLI dangling".
  it('keeps the swap ordering invariant: stop < rename < move < start', () => {
    const src = text();
    const at = (re: RegExp, what: string): number => {
      const m = re.exec(src);
      assert.ok(m, `missing ${what}`);
      return m.index;
    };
    const stop = at(/^\s*Stop-DaemonQuiet\s*$/m, 'Stop-DaemonQuiet call');
    const rename = at(/Rename-Item\s+-LiteralPath\s+\$runtimeDir/, 'rename of the live runtime');
    const move = at(/Move-Item\s+-LiteralPath\s+\$nextDir/, 'move of runtime.next');
    const start = at(/^\s*Start-DaemonQuiet\s*$/m, 'Start-DaemonQuiet call');
    assert.ok(stop < rename, '要先停守护，再给正在跑的 IDE/runtime 改名');
    assert.ok(rename < move, '要先腾位置，再把 runtime.next 搬进来');
    assert.ok(move < start, '搬完才重启守护');
  });

  // A locked .old that cannot be deleted is moved to runtime.old.<stamp>; not sweeping those adds a full runtime on every upgrade
  it('sweeps every runtime.old* leftover so a locked one cannot accumulate', () => {
    const src = text();
    assert.match(src, /-Filter\s+'runtime\.old\*'/);
    assert.match(src, /Get-ChildItem\s+-LiteralPath\s+\$libDir/);
  });

  it('can roll the swap back instead of leaving the CLI dangling', () => {
    const src = text();
    assert.match(src, /Rename-Item\s+-LiteralPath\s+\$oldDir\s+-NewName\s+'runtime'/);
  });

  it('writes a %~dp0-relative lifeline.cmd shim in ASCII', () => {
    const src = text();
    assert.match(src, /lifeline\.cmd/);
    assert.match(src, /%~dp0/);
    assert.match(src, /-Encoding ASCII/);
  });

  // User PATH read/write: the one thing most likely to wreck someone else's environment is writing the User slot
  it('only touches the User PATH, and never deletes the variable', () => {
    const src = text();
    assert.match(src, /GetEnvironmentVariable\('Path',\s*'User'\)/);
    assert.match(src, /SetEnvironmentVariable\('Path'[^\n]*'User'\)/);
    assert.doesNotMatch(src, /SetEnvironmentVariable\([^)]*,\s*\$null\)/, '传 $null 是删变量');
    // Must not write $env:Path (User+Machine concatenated) back into the User slot
    assert.doesNotMatch(src, /SetEnvironmentVariable\('Path',\s*\$env:Path/);
  });

  it('detects an upgrade and points at a daemon restart instead of re-login', () => {
    const src = text();
    assert.match(src, /Updated:/);
    assert.match(src, /lifeline daemon install/);
    assert.match(src, /lifeline setup --server-url/);
    assert.match(src, /uninstall\.ps1/);
    assert.match(src, /PowerShell/);
  });

  it('does not leak $ErrorActionPreference into the caller session (irm | iex runs in-session)', () => {
    const src = text();
    // The whole body is wrapped in a function: `$ErrorActionPreference = 'Stop'` is **function-scoped** and will not pollute the user session
    assert.match(src, /^function\s+\S+\s*\{/m);
    assert.match(src, /\$ErrorActionPreference\s*=\s*'Stop'/);
    assert.doesNotMatch(src, /^\s*exit\s/m, 'iex 里的 exit 会把用户的 PowerShell 窗口关掉');
  });

  it('does not contain any token or credential', () => {
    assert.doesNotMatch(text(), /AGENT_TOKEN|agentToken|Bearer /);
  });

  /**
   * `lifeline update` feeds this script to `powershell -Command -`: that mode executes stdin
   * **statement by statement**, so a throw inside `Install-Lifeline` only aborts that one
   * statement, then the following cleanup succeeds and **washes the process exit code to 0**
   * (measured: install failed but status=0). This trailing re-throw is the only way to make
   * the exit code honest — cannot use `exit` (`irm | iex` would close the user's PowerShell window).
   */
  it('re-raises failure at the very end so the exit code stays honest', () => {
    const src = text();
    assert.match(src, /\$installFailed = \$false/);
    assert.match(src, /if \(\$installFailed\) \{/);
    assert.match(src, /throw 'lifeline install did not complete/);
    // No further statement after the end may rewrite the exit code
    assert.equal(src.trimEnd().endsWith('}'), true, 're-throw 必须是最后一条语句');
  });
});
