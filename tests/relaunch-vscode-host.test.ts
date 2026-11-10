import type { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultVscodeHostCdpRelaunchDeps } from '../packages/agent/src/drivers/codebuddy/relaunch.js';

/**
 * The `vscode` host slot's relauncher must answer "is VSCode running" **on the
 * platform it is running on**.
 *
 * The defect this pins: the merged/pre-split code called `isVscodeRunningDarwin()`
 * unconditionally. On Windows that spawns `pgrep` / `ps` (absent), so it answers
 * false forever — `maybeRelaunch` returns `skipped-not-running` on its first line
 * and both self-heal and quiet-wake are dead for the slot, while the `codebuddy`
 * slot no longer touches VSCode at all. macOS CI cannot observe that branch
 * unless `platform` / `run` are injectable, which is why they are.
 */
function tasklist(stdout: string): typeof spawnSync {
  return (() => ({ pid: 1, output: [], stdout, stderr: '', status: 0, signal: null })) as unknown as typeof spawnSync;
}

describe('defaultVscodeHostCdpRelaunchDeps', () => {
  it('detects Code.exe on win32 through tasklist', () => {
    const deps = defaultVscodeHostCdpRelaunchDeps({
      platform: 'win32',
      run: tasklist('"Code.exe","1234","Console","1","100 K"\r\n'),
    });
    assert.equal(deps.platform, 'win32');
    assert.equal(deps.isCodeBuddyRunning(), true);
  });

  it('is dark on win32 when tasklist has no Code.exe', () => {
    const deps = defaultVscodeHostCdpRelaunchDeps({
      platform: 'win32',
      run: tasklist('INFO: No tasks are running which match the specified criteria.\r\n'),
    });
    assert.equal(deps.isCodeBuddyRunning(), false);
  });

  it('does not claim the CodeBuddy IDE app is its own host', () => {
    // The relauncher quits/reopens VSCode only; the standalone IDE belongs to the
    // `codebuddy` slot (two slots killing each other's host is what the split removed).
    const deps = defaultVscodeHostCdpRelaunchDeps({
      platform: 'win32',
      run: tasklist('"Code.exe","1234","Console","1","100 K"\r\n'),
    });
    assert.equal(deps.isCodeBuddyUpdaterRunning, undefined);
    assert.equal(typeof deps.quitCodeBuddy, 'function');
    assert.equal(typeof deps.openCodeBuddyWithCdp, 'function');
  });
});
