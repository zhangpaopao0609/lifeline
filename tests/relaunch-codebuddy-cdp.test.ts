import type { spawnSync } from 'node:child_process';
import type { CodeBuddyCdpRelaunchDeps } from '../packages/agent/src/drivers/codebuddy/relaunch.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {

  createCodeBuddyCdpRelauncher,
  defaultFindCodeBuddyExe,
  isCodeBuddyMainCommand,
  isCodeBuddyRunningWin,
  openCodeBuddyWithCdpWin,
  quitCodeBuddyWin,
} from '../packages/agent/src/drivers/codebuddy/relaunch.js';

/** Fake `spawnSync`: stdout only. */
function fakeRun(stdout: string, seen?: string[][]) {
  return ((cmd: string, args: string[] = []) => {
    seen?.push([cmd, ...args]);
    return { stdout, stderr: '', error: undefined, status: 0 };
  }) as unknown as typeof spawnSync;
}

function fakeDeps(
  overrides: Partial<CodeBuddyCdpRelaunchDeps> & Pick<CodeBuddyCdpRelaunchDeps, 'isCodeBuddyRunning'>,
): {
  deps: CodeBuddyCdpRelaunchDeps;
  quit: number;
  open: string[];
} {
  const open: string[] = [];
  let quit = 0;
  const deps: CodeBuddyCdpRelaunchDeps = {
    platform: 'darwin',
    now: () => 1_000,
    quitCodeBuddy: async () => {
      quit += 1;
      return true;
    },
    openCodeBuddyWithCdp: async (port) => {
      open.push(String(port));
    },
    log: () => {},
    ...overrides,
  };
  return {
    deps,
    get quit() {
      return quit;
    },
    open,
  };
}

describe('createCodeBuddyCdpRelauncher', () => {
  it('does nothing when CodeBuddy is not running', async () => {
    const ctx = fakeDeps({ isCodeBuddyRunning: () => false });
    const relauncher = createCodeBuddyCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(9223), 'skipped-not-running');
    assert.equal(ctx.quit, 0);
    assert.deepEqual(ctx.open, []);
  });

  it('does not relaunch on non-macOS', async () => {
    const ctx = fakeDeps({ platform: 'linux', isCodeBuddyRunning: () => true });
    const relauncher = createCodeBuddyCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(9223), 'skipped-platform');
    assert.equal(ctx.quit, 0);
  });

  // On Windows this used to be skipped-platform → never self-heals
  it('relaunches on win32 too', async () => {
    const ctx = fakeDeps({ platform: 'win32', isCodeBuddyRunning: () => true });
    const relauncher = createCodeBuddyCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(0), 'relaunched');
    assert.equal(ctx.quit, 1);
    assert.deepEqual(ctx.open, ['0']);
  });

  it('does not quit when the exe cannot be found', async () => {
    const ctx = fakeDeps({
      platform: 'win32',
      isCodeBuddyRunning: () => true,
      canRelaunch: () => false,
    });
    const relauncher = createCodeBuddyCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(0), 'skipped-no-exe');
    assert.equal(ctx.quit, 0, '拉不起来就绝不能退');
    assert.deepEqual(ctx.open, []);
  });
});

describe('isCodeBuddyRunningWin', () => {
  // Measured: both product names may be running (CN / international), and the image name **contains a space**
  it('matches either product name, exactly', () => {
    assert.equal(isCodeBuddyRunningWin({ run: fakeRun('"CodeBuddy CN.exe","1","Console","1","1 K"') }), true);
    assert.equal(isCodeBuddyRunningWin({ run: fakeRun('"CodeBuddy.exe","1","Console","1","1 K"') }), true);
  });

  it('does not treat Cursor or the no-match banner as CodeBuddy running', () => {
    assert.equal(isCodeBuddyRunningWin({ run: fakeRun('"Cursor.exe","1","Console","1","1 K"') }), false);
    assert.equal(
      isCodeBuddyRunningWin({ run: fakeRun('INFO: No tasks are running which match the specified criteria.') }),
      false,
    );
  });
});

describe('quitCodeBuddyWin', () => {
  it('sends taskkill for both product names and never /F', async () => {
    const seen: string[][] = [];
    await quitCodeBuddyWin({
      run: fakeRun('', seen),
      isRunning: () => false,
      now: () => 0,
      waitMs: 0,
      pollMs: 1,
      sleep: async () => {},
    });
    assert.deepEqual(seen, [
      ['taskkill', '/IM', 'CodeBuddy CN.exe'],
      ['taskkill', '/IM', 'CodeBuddy.exe'],
    ]);
    assert.equal(seen.some(c => c.includes('/F')), false);
  });
});

describe('openCodeBuddyWithCdpWin', () => {
  it('spawns the resolved exe detached with the debug port', async () => {
    const spawned: Array<[string, string[]]> = [];
    await openCodeBuddyWithCdpWin(0, {
      findExe: () => 'C:\\prog\\CodeBuddy CN\\CodeBuddy CN.exe',
      spawnDetached: (exe, args) => spawned.push([exe, args]),
      log: () => {},
    });
    assert.deepEqual(spawned, [
      ['C:\\prog\\CodeBuddy CN\\CodeBuddy CN.exe', ['--remote-debugging-port=0']],
    ]);
  });

  it('reports a hard failure instead of silently returning when the exe is missing', async () => {
    const spawned: unknown[] = [];
    const logs: string[] = [];
    await openCodeBuddyWithCdpWin(0, {
      findExe: () => undefined,
      spawnDetached: (exe, args) => spawned.push([exe, args]),
      log: m => logs.push(m),
    });
    assert.deepEqual(spawned, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /not found/);
    // Display name includes both product names so the log shows which one is being looked for
    assert.match(logs[0]!, /CodeBuddy CN\.exe \/ CodeBuddy\.exe/);
  });
});

describe('defaultFindCodeBuddyExe', () => {
  // The predicate must be **separator-agnostic**: candidate paths are join()-generated per platform; a hard-coded backslash always fails on macOS
  const isCnPerUser = (p: string) => /CodeBuddy CN[\\/]CodeBuddy CN\.exe$/i.test(p);

  it('takes the first existing candidate', () => {
    const exe = defaultFindCodeBuddyExe({ exists: isCnPerUser, queryRegistry: () => undefined });
    assert.ok(exe, '按用户安装的候选应命中');
    assert.match(exe!, /CodeBuddy CN\.exe$/i);
  });

  it('falls back to App Paths when no candidate exists', () => {
    const exe = defaultFindCodeBuddyExe({
      exists: p => /D:[\\/]weird[\\/]CodeBuddy CN\.exe$/i.test(p),
      queryRegistry: () => '    (Default)    REG_SZ    D:\\weird\\CodeBuddy CN.exe',
    });
    assert.ok(exe);
    assert.match(exe!, /D:[\\/]weird[\\/]CodeBuddy CN\.exe$/i);
  });

  // ⚠️ Stub every registry hook: missing `queryUninstall` would hit a real `reg query` (tests must not touch the real registry,
  // and that spawn has a 5s timeout — it becomes a flaky slow test)
  it('returns undefined when nothing exists (caller then reports skipped-no-exe)', () => {
    assert.equal(
      defaultFindCodeBuddyExe({
        exists: () => false,
        queryRegistry: () => undefined,
        queryUninstall: () => undefined,
      }),
      undefined,
    );
  });
});

describe('isCodeBuddyMainCommand', () => {
  it('matches CodeBuddy CN even when the binary is Electron', () => {
    assert.equal(
      isCodeBuddyMainCommand(
        '/Applications/CodeBuddy CN.app/Contents/MacOS/Electron',
        'CodeBuddy CN',
      ),
      true,
    );
  });

  it('does not treat helpers or Cursor as the CodeBuddy main process', () => {
    assert.equal(
      isCodeBuddyMainCommand(
        '/Applications/CodeBuddy CN.app/Contents/Frameworks/CodeBuddy CN Helper.app/Contents/MacOS/CodeBuddy CN Helper',
        'CodeBuddy CN',
      ),
      false,
    );
    assert.equal(
      isCodeBuddyMainCommand(
        '/Applications/Cursor.app/Contents/MacOS/Cursor',
        'CodeBuddy CN',
      ),
      false,
    );
  });
});
