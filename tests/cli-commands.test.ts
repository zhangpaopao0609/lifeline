import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIR = join(ROOT, 'packages/cli/src');

/**
 * Predicate functions are scattered across index / commands / daemon / installer
 * (2026-09-21 structure resettlement): concatenate into one big source and split by function name —
 * names are globally unique, so functionBody's split stays the same.
 */
const cli = [
  'index.ts',
  'ui.ts',
  'cdp-argv-state.ts',
  'installer.ts',
  'commands/setup.ts',
  'commands/start.ts',
  'commands/status.ts',
  'commands/update.ts',
  'commands/open.ts',
  'commands/daemon.ts',
  'daemon/launchd.ts',
  'daemon/systemd.ts',
  'daemon/windows.ts',
  'daemon/stop.ts',
]
  .map(f => readFileSync(join(CLI_DIR, f), 'utf-8'))
  .join('\n\n');

/** Split a function body by brace matching: the predicate is "did it do X", independent of what sits around the function. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in packages/cli/src/**`);

  // Skip the parameter list before looking for the body: signatures contain `{}` (`opts: T = {}`, type literals, destructuring),
  // so a raw `indexOf('{')` treats `= {}` as the body start and slices one line — then `doesNotMatch`
  // assertions **pass falsely** because "those lines were never read". T11's return type and T12's default each tripped this once.
  //
  // Skipping the parameter list is still not enough: **the return type itself can carry braces**
  // (`): { ok: true } | { ok: false; error: string } {` — the launchd group tripped this on 2026-09-21).
  // The body's `{` is the **last** one on the signature line in this codebase, so take that; when the
  // line has none (return type on its own line), fall back to the first `{` after the parameter list.
  let paren = 0;
  let parenEnd = -1;
  for (let i = source.indexOf('(', start); i < source.length; i++) {
    if (source[i] === '(') {
      paren++;
    }
    else if (source[i] === ')') {
      paren--;
      if (paren === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  assert.ok(parenEnd >= 0, `could not find the parameter list of ${name}()`);

  const lineEnd = source.indexOf('\n', parenEnd);
  const rest = source.slice(parenEnd, lineEnd >= 0 ? lineEnd : undefined);
  const onSignatureLine = rest.lastIndexOf('{');
  const bodyStart = onSignatureLine >= 0 ? parenEnd + onSignatureLine : source.indexOf('{', parenEnd);
  assert.ok(bodyStart >= 0, `could not find the body of ${name}()`);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{')
      depth++;
    else if (source[i] === '}' && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error(`Unbalanced braces while reading ${name}()`);
}

/**
 * HELP is the command's public face: written-but-unimplemented (or implemented-but-unwritten) must show up here.
 * `lifeline stop` was added by walking this list — do not add a command later and omit HELP or dispatch.
 */
describe('CLI command surface', () => {
  it('every command in HELP is handled by main()', () => {
    const documented = [...cli.matchAll(/^ {2}lifeline ([a-z-]+)/gm)].map(m => m[1]);
    assert.ok(documented.length >= 8, `HELP parsed too few commands: ${documented.join(', ')}`);
    for (const cmd of documented) {
      assert.match(cli, new RegExp(`case '${cmd}':`), `HELP lists "lifeline ${cmd}", but main() has no case for it`);
    }
  });

  /**
   * Stop ≠ uninstall: `stop` only stops the daemon; registration (plist / unit) stays. Removing CDP argv
   * and deleting the plist / unit is `daemon uninstall` — do not turn stop into a call-through to uninstall.
   */
  it('stop stops the daemon without uninstalling it', () => {
    const stop = functionBody(cli, 'cmdStop');
    assert.match(stop, /launchctl bootout/);
    assert.match(cli, /systemctl --user stop \$\{LINUX_SERVICE_UNIT\}/);
    assert.match(stop, /STOP_NOTE_KEPT/);
    assert.doesNotMatch(stop, /revertCursorCdpArgvIfManaged|revertCodeBuddyCdpArgvIfManaged/);
    assert.doesNotMatch(stop, /unlinkSync|rm -f|rm "/);
  });
});

// Platform-aware: `update` is the **only** path that can self-replace runtime, and Windows file locks make its order differ from POSIX.
describe('platform-aware install/update', () => {
  it('names the runtime node binary per platform', () => {
    const body = functionBody(cli, 'runtimeNodeName');
    assert.match(body, /win32/);
    assert.match(body, /node\.exe/);
  });

  it('runs install.ps1 through powershell on Windows, sh -s elsewhere', () => {
    const body = functionBody(cli, 'installerInvocation');
    assert.match(body, /powershell\.exe/);
    assert.match(body, /'-NoProfile'/);
    assert.match(body, /'-ExecutionPolicy',\s*'Bypass'/);
    // Both paths go through stdin: that is therefore the only platform branch in the CLI (script content never enters the command line)
    assert.match(body, /'-Command',\s*'-'/);
    assert.match(body, /'sh'/);
  });

  it('picks the script name instead of hard-coding install.sh', () => {
    assert.match(functionBody(cli, 'installerScriptName'), /install\.ps1/);
    const installer = functionBody(cli, 'runInstaller');
    assert.match(installer, /installerScriptName\(\)/);
    assert.doesNotMatch(installer, /install\.sh/, 'runInstaller 里不该再写死 install.sh');
    assert.match(installer, /installerInvocation\(\)/);
  });

  // Windows daemon = scheduled task + supervisor script (`RestartOnFailure` was measured never
  // to restart on non-zero exit, so self-heal can only come from the script's own loop; see
  // the top of win-daemon.ts).
  it('routes daemon / stop / restart to the Windows ladder', () => {
    assert.match(functionBody(cli, 'cmdDaemon'), /process\.platform === 'win32'[\s\S]*?cmdDaemonWindows/);
    // All three must go through the **same** stop-daemon entry (`stopWindowsDaemon` includes
    // `windowsStopPsCommand`'s stop + orphan reclaim) — duplicating the statement means only one place gets updated.
    assert.match(functionBody(cli, 'cmdStop'), /process\.platform === 'win32'[\s\S]*?stopWindowsDaemon/);
    assert.match(
      functionBody(cli, 'restartDaemon'),
      /process\.platform === 'win32'[\s\S]*?stopWindowsDaemon[\s\S]*?startWindowsDaemon/,
      'Windows 上必须"先停（含孤儿回收）再启"',
    );
  });

  it('writes the supervisor script and registers the task on install', () => {
    const body = functionBody(cli, 'cmdDaemonWindows');
    assert.match(body, /writeWindowsDaemonScript/);
    assert.match(body, /windowsRegisterPsCommand/);
  });

  // On-machine (2026-09-20): the fallback path (`startDetachedAgent`) starts an agent not in the
  // task tree; a reinstall never clears it — it keeps holding agent.out.log, every supervisor
  // round's `1>>` fails to open, node is never launched, and the web keeps saying "updatable"
  // (with no log trace). install must stop the previous daemon first.
  it('stops the previous daemon before (re)installing', () => {
    const body = functionBody(cli, 'cmdDaemonWindows');
    const stop = body.indexOf('stopWindowsDaemon');
    const write = body.indexOf('writeWindowsDaemonScript');
    assert.ok(stop >= 0, 'install 要先停旧守护（旧任务实例 / 降级起的孤儿 agent）');
    assert.ok(stop < write, '先停、再写脚本/注册');
  });

  // Task Running only means the supervisor is running: the agent may fail at the launch layer
  // every round. install must read back the **process table**, or "Installed and started" is a
  // false success (hit on machine: the user thought the upgrade finished, still running the old process).
  //
  // The criterion must be a **set difference**: `lifeline daemon install`'s own command line
  // contains lifeline.mjs, so "did anything match" is always true (a defect measured in code
  // review). Assertions pin **call shape**, not names — comments in the function body also
  // contain those identifiers, so matching names still passes if the call is deleted.
  it('reads back the process table by pid diff, not by "did anything match"', () => {
    const body = functionBody(cli, 'cmdDaemonWindows');
    assert.match(body, /windowsLifelinePidsPsCommand\(/, '先取"启动前那一份"');
    assert.match(body, /windowsAgentProbePsCommand\(/, '启动后再探一次');
    assert.match(body, /newLifelinePids\(/, '判据是集合差，不是"有没有命中"');
    assert.match(body, /parseWindowsAgentPids\(/);
    assert.match(body, /excludePid: process\.pid/, 'CLI 自己的 pid 必须排除（它的命令行也含 lifeline.mjs）');
  });

  // Tell the truth: task running ≠ agent running. Neither summary (setup report) nor headline (CLI) may unconditionally say "Installed and started".
  it('reports a false-success instead of claiming the agent is up', () => {
    const body = functionBody(cli, 'cmdDaemonWindows');
    assert.match(body, /but the agent is not running/);
    assert.match(body, /did not come up/);
  });

  // ExecutionTimeLimit defaults to 72 hours and would silently kill the agent after three days — must read back
  it('reads ExecutionTimeLimit back and flags a non-zero value', () => {
    const body = functionBody(cli, 'cmdDaemonWindows');
    assert.match(body, /windowsStatusPsCommand/);
    assert.match(body, /00:00:00/);
  });

  it('falls back to a detached process when the task cannot be registered', () => {
    const body = functionBody(cli, 'cmdDaemonWindows');
    assert.match(body, /startDetachedAgent/);
    assert.match(body, /not restarted after a crash/);
    // Fallback path is a detached spawn — without windowsHide on Windows a console window pops
    assert.match(functionBody(cli, 'startDetachedAgent'), /windowsHide:\s*true/);
  });

  it('keeps the registration on stop, and only uninstall removes it', () => {
    assert.doesNotMatch(functionBody(cli, 'cmdStop'), /Unregister|windowsUnregisterPsCommand/);
    assert.match(functionBody(cli, 'cmdDaemonWindows'), /windowsUnregisterPsCommand/);
  });

  it('resolves the platform node binary in update', () => {
    const body = functionBody(cli, 'cmdUpdate');
    assert.match(body, /runtimeNodeName\(\)/);
    assert.doesNotMatch(body, /'node'\s*\)/, '不许再写死 runtime/node');
  });

  /**
   * Order is a **hard requirement**, not style: install.ps1 uses rename to dodge a running
   * node.exe, but if the supervisor is still running it will relaunch the process from the
   * just-renamed directory the instant the swap finishes — looks like "agent vanished after update".
   */
  it('stops the Windows daemon BEFORE the swap and starts it after', () => {
    const body = functionBody(cli, 'cmdUpdate');
    const stop = body.indexOf('stopWindowsDaemon');
    const install = body.indexOf('runInstaller');
    const start = body.indexOf('startWindowsDaemon');
    assert.ok(stop >= 0, 'cmdUpdate 必须调 stopWindowsDaemon');
    assert.ok(install >= 0, 'cmdUpdate 必须调 runInstaller');
    assert.ok(start >= 0, 'cmdUpdate 必须调 startWindowsDaemon');
    assert.ok(stop < install, '要先停守护（文件锁 + 监管脚本会立刻把进程拉回来）');
    assert.ok(install < start, '装完才能重启守护');
  });

  it('only does the stop/start dance on win32', () => {
    const body = functionBody(cli, 'cmdUpdate');
    assert.match(body, /process\.platform === 'win32'/);
    // POSIX still goes "swap first then restartDaemon"
    assert.match(body, /restartDaemon\(\)/);
  });

  // Use execFileSync rather than concatenating a shell string: one less quoting layer on Windows
  it('runs the post-install version check without a shell', () => {
    const body = functionBody(cli, 'installedVersion');
    assert.match(body, /execFileSync/);
    assert.doesNotMatch(body, /execSync\(`"/, '不要拼 "nodeBin" "mjs" --version 这种命令串');
  });

  /**
   * Measured (live machine): `powershell.exe` spawned by node inherits a `PSModulePath` that puts the
   * **PowerShell 7** module dir before 5.1, so 5.1 cannot even resolve `Get-FileHash` — the installer
   * fails at sha256 while `update` reports success because the exit code is 0. The 5.1 module dir must be **prepended**.
   */
  it('prepends the PowerShell 5.1 module dir on Windows', () => {
    const body = functionBody(cli, 'installerEnv');
    assert.match(body, /PSModulePath/);
    assert.match(body, /WindowsPowerShell/);
    assert.match(body, /if \(platform !== 'win32'\)\s*return env;/);
    assert.match(body, /\$\{psModules\};\$\{env\.PSModulePath/, '必须是前置（保留用户自己的模块路径）');
    assert.match(functionBody(cli, 'runInstaller'), /installerEnv\(env\)/, 'runInstaller 必须用它');
  });

  /**
   * Measured: `powershell -Command -` executes stdin statement by statement, so a throw inside the
   * installer followed by a successful cleanup washes the exit code to 0. Success must mean "the new runtime can run".
   */
  it('treats a non-running installed runtime as a failed update', () => {
    const body = functionBody(cli, 'cmdUpdate');
    assert.match(body, /if \(!now\)/, 'installedVersion() 返回 null 必须当失败');
    // On the failure path: Windows stops the daemon first, so it must be started back up before reporting the error (order matters too)
    assert.match(
      body,
      /if \(!now\)[\s\S]*?if \(onWindows\)\s*startWindowsDaemon\(\);[\s\S]*?Update failed:/,
      '失败路径要先重启守护、再报错',
    );
  });
});

/**
 * Real-machine incident (2026-09-21): after the CLI / runtime updated to 0.1.73 the agent never came
 * back — the web console showed it offline for good.
 *
 * What the machine looked like: the plist was there, `launchctl print` said the job was **never
 * loaded**, and agent.out.log ended at `[agent] Shutting down...` with no startup banner after it
 * (the old process was booted out, the new one was never registered).
 *
 * Reproduction on that machine (macOS 15): booting out a **live** job and calling bootstrap right
 * away always fails with `Bootstrap failed: 5: Input/output error` — delay=0s fails every time,
 * 50ms always succeeds, so it is a narrow time window and not a bad plist. Worse, legacy
 * `launchctl load -w` prints `Load failed: 5: Input/output error` and **still exits 0**, so the old
 * fallback (`if (!tryRun(load -w)) return { ok: true }`) reported "Installed and started" for an
 * agent that did not exist.
 */
describe('launchd install/restart verdicts', () => {
  it('waits out the bootout → bootstrap EIO window', () => {
    const body = functionBody(cli, 'bootstrapLaunchd');
    assert.match(body, /sleepSync\(BOOTSTRAP_DELAY_MS\)/, 'bootstrap right after bootout always fails; wait first');
    assert.ok(
      body.indexOf('sleepSync(BOOTSTRAP_DELAY_MS)') < body.indexOf('launchctl bootstrap'),
      'wait first, then register',
    );
  });

  it('judges registration by reading the job back, never by launchctl exit codes', () => {
    const body = functionBody(cli, 'bootstrapLaunchd');
    assert.match(body, /launchdJobLoaded\(serviceRef\)/, 'the verdict is the read-back');
    assert.doesNotMatch(body, /!tryRun\(/, 'load -w exits 0 even when it fails — its result is not a verdict');
    // Read back after *every* attempt (once inside the loop + once after the load -w fallback):
    // bootstrap can report an error and still register, or report nothing and not register.
    assert.ok(
      body.split('launchdJobLoaded(serviceRef)').length - 1 >= 2,
      'not just once at the end — read back after every attempt',
    );
  });

  it('restarts an already-registered daemon instead of re-registering it', () => {
    const body = functionBody(cli, 'cmdDaemonLaunchd');
    assert.match(
      body,
      /readFileSync\(plistPath, 'utf-8'\) === plist/,
      'compare the registration first (an update leaves it byte-identical)',
    );
    assert.match(body, /launchdJobLoaded\(serviceRef\)/, 'and require the job to still be loaded');
    assert.match(
      body,
      /if \(restartOnly\)\s*\{[\s\S]*?kickstartLaunchd\(serviceRef\)/,
      'unchanged registration → restart in place (kickstart never touches it, so there is no EIO window)',
    );
    assert.match(
      body,
      /\}\s*else\s*\{[\s\S]*?launchctl bootout[\s\S]*?bootstrapLaunchd\(/,
      'only re-register when the registration actually changed',
    );
  });

  it('uses the same verified kickstart for update/restart', () => {
    assert.match(
      functionBody(cli, 'restartDaemon'),
      /kickstartLaunchd\(/,
      '`lifeline update` and daemon install share one entry point',
    );
    assert.match(
      functionBody(cli, 'kickstartLaunchd'),
      /launchdJobLoaded\(serviceRef\)/,
      'kickstart reads back too — its exit code is not proof',
    );
  });

  // The last gate against a false success: the `install.sh && lifeline daemon install` upgrade chain
  // judges by exit code, so ok:false has to become a non-zero exit or scripts keep going.
  it('exits non-zero when daemon install could not start the agent', () => {
    const body = functionBody(cli, 'main');
    assert.match(body, /cmdDaemon\(sub \?\? 'status'\)/);
    assert.match(body, /!outcome\.ok[\s\S]*?process\.exit\(1\)/, 'a failed install must reach the exit code');
  });
});
