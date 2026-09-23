import type { spawnSync } from 'node:child_process';
import type { CursorCdpRelaunchDeps } from '../packages/agent/src/drivers/cursor/relaunch.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cdpPortFromUrl,
  createIdeCdpRelauncher,
  isCdpUnreachable,
  isProcessRunningWin,
  memoizeExeWithTtl,
  nextReconnectDelay,
  parseTasklistImages,
  quitProcessWin,
  RELAUNCH_PLATFORMS,
} from '../packages/agent/src/cdp/relaunch-engine.js';
import {
  createCursorCdpRelauncher,

  openCursorWithCdpWin,
} from '../packages/agent/src/drivers/cursor/relaunch.js';
import { canControlIde } from '../packages/agent/src/live-ides.js';

/** Fake `spawnSync`: stdout only, enough for the relaunch layer. */
function fakeRun(stdout: string, seen?: string[][]) {
  return ((cmd: string, args: string[] = []) => {
    seen?.push([cmd, ...args]);
    return { stdout, stderr: '', error: undefined, status: 0 };
  }) as unknown as typeof spawnSync;
}

function fakeDeps(overrides: Partial<CursorCdpRelaunchDeps> & Pick<CursorCdpRelaunchDeps, 'isCursorRunning'>): {
  deps: CursorCdpRelaunchDeps;
  quit: number;
  open: string[];
} {
  const open: string[] = [];
  let quit = 0;
  const deps: CursorCdpRelaunchDeps = {
    platform: 'darwin',
    now: () => 1_000,
    quitCursor: async () => {
      quit += 1;
      return true;
    },
    openCursorWithCdp: async (port) => {
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

describe('isCdpUnreachable', () => {
  it('is true when the HTTP debug port is down', () => {
    assert.equal(isCdpUnreachable(new Error('fetch failed')), true);
    assert.equal(isCdpUnreachable(new Error('ECONNREFUSED')), true);
  });

  it('is false when our /json fetch timed out — Cursor may already have a live debugger', () => {
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    assert.equal(isCdpUnreachable(aborted), false);
    assert.equal(isCdpUnreachable(new Error('The operation was aborted')), false);
  });

  it('is false when CDP is up but no workbench target exists', () => {
    assert.equal(isCdpUnreachable(new Error('No suitable CDP target found')), false);
  });
});

describe('nextReconnectDelay', () => {
  it('stays short while the debug port is down so a Dock launch is noticed quickly', () => {
    assert.equal(nextReconnectDelay(1000, { unreachable: true, max: 30_000 }), 500);
    assert.equal(nextReconnectDelay(16_000, { unreachable: true, max: 30_000 }), 500);
  });

  it('still backs off when CDP was up and then dropped', () => {
    assert.equal(nextReconnectDelay(1000, { unreachable: false, max: 30_000 }), 2000);
    assert.equal(nextReconnectDelay(16_000, { unreachable: false, max: 30_000 }), 30_000);
  });
});

describe('cdpPortFromUrl', () => {
  it('reads the port from the configured CDP URL', () => {
    assert.equal(cdpPortFromUrl('http://127.0.0.1:9222'), 9222);
  });
});

describe('createCursorCdpRelauncher', () => {
  it('does nothing when Cursor is not running', async () => {
    const ctx = fakeDeps({ isCursorRunning: () => false });
    const relauncher = createCursorCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(9222), 'skipped-not-running');
    assert.equal(ctx.quit, 0);
    assert.deepEqual(ctx.open, []);
  });

  it('waits a short grace so a launch that is about to bind 9222 is not killed', async () => {
    let now = 10_000;
    const ctx = fakeDeps({
      isCursorRunning: () => true,
      now: () => now,
    });
    const relauncher = createCursorCdpRelauncher({ graceMs: 1500, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(9222), 'skipped-warming-up');
    assert.equal(ctx.quit, 0);
    now = 11_400;
    assert.equal(await relauncher.maybeRelaunch(9222), 'skipped-warming-up');
    now = 11_500;
    assert.equal(await relauncher.maybeRelaunch(9222), 'relaunched');
    assert.equal(ctx.quit, 1);
  });

  it('quits and relaunches with the caller debug port when Cursor is running', async () => {
    const ctx = fakeDeps({ isCursorRunning: () => true });
    const relauncher = createCursorCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    const port = 5555;
    assert.equal(await relauncher.maybeRelaunch(port), 'relaunched');
    assert.equal(ctx.quit, 1);
    assert.deepEqual(ctx.open, [String(port)]);
  });

  it('relaunches with port 0 so Chromium picks the debug port', async () => {
    const ctx = fakeDeps({ isCursorRunning: () => true });
    const relauncher = createCursorCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(0), 'relaunched');
    assert.deepEqual(ctx.open, ['0']);
  });

  it('does not open a second instance if quit did not finish', async () => {
    const ctx = fakeDeps({
      isCursorRunning: () => true,
      quitCursor: async () => false,
    });
    const relauncher = createCursorCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(9222), 'skipped-quit-pending');
    assert.deepEqual(ctx.open, []);
  });

  it('skips a second attempt inside the cooldown', async () => {
    let now = 10_000;
    const ctx = fakeDeps({
      isCursorRunning: () => true,
      now: () => now,
    });
    const relauncher = createCursorCdpRelauncher({ graceMs: 0, cooldownMs: 60_000, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(9222), 'relaunched');
    now = 20_000;
    assert.equal(await relauncher.maybeRelaunch(9222), 'skipped-cooldown');
    assert.equal(ctx.quit, 1);
  });

  it('stops after a burst of relaunches inside the window (guards against a kill loop)', async () => {
    let now = 10_000;
    const ctx = fakeDeps({ isCursorRunning: () => true, now: () => now });
    const relauncher = createCursorCdpRelauncher({
      graceMs: 0,
      cooldownMs: 1_000,
      burstWindowMs: 10_000,
      burstMax: 2,
      deps: ctx.deps,
    });
    assert.equal(await relauncher.maybeRelaunch(0), 'relaunched');
    now += 2_000;
    assert.equal(await relauncher.maybeRelaunch(0), 'relaunched');
    now += 2_000;
    assert.equal(await relauncher.maybeRelaunch(0), 'skipped-throttled');
    assert.equal(ctx.quit, 2, '第三次不该真的去退 IDE');
    now += 20_000; // Allow through once past the window
    assert.equal(await relauncher.maybeRelaunch(0), 'relaunched');
  });

  it('does not count a failed quit against the burst guard', async () => {
    let now = 10_000;
    let quitTries = 0;
    // A save dialog is blocking → there was never a real relaunch, so it must not count as "repeated false relaunch"
    const ctx = fakeDeps({
      isCursorRunning: () => true,
      now: () => now,
      quitCursor: async () => {
        quitTries += 1;
        return false;
      },
    });
    const relauncher = createCursorCdpRelauncher({
      graceMs: 0,
      cooldownMs: 1_000,
      burstWindowMs: 10_000,
      burstMax: 1,
      deps: ctx.deps,
    });
    for (let i = 0; i < 4; i++) {
      assert.equal(await relauncher.maybeRelaunch(0), 'skipped-quit-pending');
      now += 2_000;
    }
    assert.equal(quitTries, 4, '每次都试了退出');
    assert.deepEqual(ctx.open, [], '一次都没真拉起 → 不该入账，所以永远不会被 throttle');
  });

  it('clears the burst counter once we are connected again', async () => {
    let now = 10_000;
    const ctx = fakeDeps({ isCursorRunning: () => true, now: () => now });
    const relauncher = createCursorCdpRelauncher({
      graceMs: 0,
      cooldownMs: 1_000,
      burstWindowMs: 10_000,
      burstMax: 1,
      deps: ctx.deps,
    });
    assert.equal(await relauncher.maybeRelaunch(0), 'relaunched');
    now += 2_000;
    assert.equal(await relauncher.maybeRelaunch(0), 'skipped-throttled');
    // Dock cold start → self-heal → connected: reset the counter so the next Dock cold start can still self-heal
    relauncher.noteConnected();
    now += 2_000;
    assert.equal(await relauncher.maybeRelaunch(0), 'relaunched');
  });

  it('does not relaunch on non-macOS', async () => {
    const ctx = fakeDeps({ platform: 'linux', isCursorRunning: () => true });
    const relauncher = createCursorCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(9222), 'skipped-platform');
    assert.equal(ctx.quit, 0);
  });

  it('relaunches on win32 too (it used to be skipped-platform)', async () => {
    const ctx = fakeDeps({ platform: 'win32', isCursorRunning: () => true });
    const relauncher = createCursorCdpRelauncher({ graceMs: 0, deps: ctx.deps });
    assert.equal(await relauncher.maybeRelaunch(0), 'relaunched');
    assert.equal(ctx.quit, 1);
    assert.deepEqual(ctx.open, ['0']);
  });

  // "Quit first, then launch" has a trap: failing to launch means you just closed the user's IDE.
  // So **confirm we can launch first**; if we cannot, do not quit.
  it('does not quit when the IDE cannot be relaunched (exe not found)', async () => {
    let quit = 0;
    const logs: string[] = [];
    const relauncher = createIdeCdpRelauncher({
      productName: 'Cursor',
      graceMs: 0,
      deps: {
        platform: 'win32',
        now: () => 1_000,
        isRunning: () => true,
        canRelaunch: () => false,
        quit: async () => {
          quit += 1;
          return true;
        },
        openWithCdp: async () => {},
        log: m => logs.push(m),
      },
    });
    assert.equal(await relauncher.maybeRelaunch(0), 'skipped-no-exe');
    assert.equal(quit, 0, '拉不起来就绝不能退');
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /NOT quitting it/);
  });

  // Regression: `skipped-no-exe` must **not** consume cooldown. Otherwise the next attempt (after cdp-bridge's quiet reconnect 30s)
  // becomes `skipped-cooldown`, and cdp-bridge's **default branch for that is 500ms fast poll**,
  // producing a periodic "quiet 30s + fast-poll 30s" jitter.
  it('keeps reporting skipped-no-exe across attempts instead of slipping into the cooldown branch', async () => {
    let now = 10_000;
    const relauncher = createIdeCdpRelauncher({
      productName: 'Cursor',
      graceMs: 0,
      cooldownMs: 60_000,
      deps: {
        platform: 'win32',
        now: () => now,
        isRunning: () => true,
        canRelaunch: () => false,
        quit: async () => {
          throw new Error('must not quit');
        },
        openWithCdp: async () => {
          throw new Error('must not open');
        },
        log: () => {},
      },
    });
    assert.equal(await relauncher.maybeRelaunch(0), 'skipped-no-exe');
    now += 30_000; // cdp-bridge quiet-reconnect interval
    assert.equal(await relauncher.maybeRelaunch(0), 'skipped-no-exe');
    now += 300_000;
    assert.equal(await relauncher.maybeRelaunch(0), 'skipped-no-exe');
  });

  // The cost of "does not consume cooldown" above is a hit every 30s reconnect — without dedupe that is two permanent noise lines per minute
  it('logs the missing-exe reason only once until we connect again', async () => {
    const logs: string[] = [];
    let now = 10_000;
    const relauncher = createIdeCdpRelauncher({
      productName: 'Cursor',
      graceMs: 0,
      deps: {
        platform: 'win32',
        now: () => now,
        isRunning: () => true,
        canRelaunch: () => false,
        quit: async () => true,
        openWithCdp: async () => {},
        log: m => logs.push(m),
      },
    });
    await relauncher.maybeRelaunch(0);
    now += 30_000;
    await relauncher.maybeRelaunch(0);
    assert.equal(logs.length, 1, '每 30s 的重连不该重复刷同一行');
    relauncher.noteConnected();
    now += 30_000;
    await relauncher.maybeRelaunch(0);
    assert.equal(logs.length, 2, '连上过之后重置，问题还在就能再报一次');
  });
});

// The "relaunch platform set" and "can we control the IDE" must agree: missing one → no-listener fast-polls at 500ms
// forever; an extra one → we kill the user's IDE on a platform that is not supported at all.
describe('RELAUNCH_PLATFORMS', () => {
  it('agrees with canControlIde on every platform we know about', () => {
    for (const p of ['darwin', 'win32', 'linux', 'freebsd'] as const) {
      assert.equal(RELAUNCH_PLATFORMS.includes(p), canControlIde(p), `platform ${p}`);
    }
  });
});

describe('parseTasklistImages / isProcessRunningWin', () => {
  it('reads one image name per CSV row', () => {
    const out = [
      '"Cursor.exe","10300","Console","1","378,712 K"',
      '"Cursor.exe","8292","Console","1","131,720 K"',
    ].join('\r\n');
    assert.deepEqual(parseTasklistImages(out), ['Cursor.exe', 'Cursor.exe']);
  });

  it('returns [] for the no-match banner', () => {
    assert.deepEqual(parseTasklistImages('INFO: No tasks are running which match the specified criteria.'), []);
    assert.deepEqual(parseTasklistImages(''), []);
  });

  it('needs the image name to appear', () => {
    assert.equal(isProcessRunningWin('Cursor.exe', { run: fakeRun('"Cursor.exe","1","Console","1","1 K"') }), true);
    assert.equal(
      isProcessRunningWin('Cursor.exe', {
        run: fakeRun('INFO: No tasks are running which match the specified criteria.'),
      }),
      false,
    );
  });

  // includes(imageName) false-positives: 'NotCursor.exe'.includes('Cursor.exe') is true
  it('does not match a different image that merely contains the name', () => {
    assert.equal(isProcessRunningWin('Cursor.exe', { run: fakeRun('"NotCursor.exe","1","Console","1","1 K"') }), false);
  });

  it('treats image names case-insensitively (Windows exe names are)', () => {
    assert.equal(isProcessRunningWin('CodeBuddy CN.exe', { run: fakeRun('"CODEBUDDY CN.EXE","1","Console","1","1 K"') }), true);
  });

  it('asks tasklist for the CSV image column only', () => {
    const seen: string[][] = [];
    isProcessRunningWin('Cursor.exe', { run: fakeRun('', seen) });
    assert.deepEqual(seen[0], ['tasklist', '/FI', 'IMAGENAME eq Cursor.exe', '/NH', '/FO', 'CSV']);
  });
});

describe('quitProcessWin', () => {
  it('sends /IM <image> and never /F', async () => {
    const seen: string[][] = [];
    await quitProcessWin('CodeBuddy CN.exe', {
      run: fakeRun('', seen),
      isRunning: () => false,
      now: () => 0,
      waitMs: 10,
      pollMs: 1,
      sleep: async () => {},
    });
    assert.deepEqual(seen[0], ['taskkill', '/IM', 'CodeBuddy CN.exe']);
    // "A single image name is issued once": `quitProcessWin` was later generalized to take an array; this guards the degenerate path
    assert.equal(seen.length, 1);
  });

  // Measured: taskkill replies "can only be terminated forcefully" for windowless Electron children,
  // but after the parent exits the children all follow — so **error / exit code are not failure**; only isRunning() counts.
  it('judges success by isRunning(), not by the taskkill result', async () => {
    let t = 0;
    let polls = 0;
    const quit = await quitProcessWin('Cursor.exe', {
      run: (() => ({ stdout: '', stderr: 'ERROR: cannot terminate', error: new Error('boom') })) as unknown as typeof spawnSync,
      isRunning: () => !((++polls) >= 2),
      now: () => (t += 1000),
      waitMs: 5000,
      pollMs: 1,
      sleep: async () => {},
    });
    assert.equal(quit, true, '进程没了就是成功，哪怕 taskkill 报了错');
  });

  it('gives up (false) when the process is still alive after the deadline', async () => {
    let t = 0;
    const quit = await quitProcessWin('Cursor.exe', {
      run: fakeRun(''),
      isRunning: () => true,
      now: () => (t += 1000),
      waitMs: 2000,
      pollMs: 1,
      sleep: async () => {},
    });
    assert.equal(quit, false);
  });

  // Guard: pollMs=0 with a frozen now busy-loops. When waitMs=0 skip the loop and finish on the last verdict.
  it('does not spin when waitMs / pollMs are zero', async () => {
    let running = true;
    const deps = {
      run: fakeRun(''),
      isRunning: () => running,
      now: () => 0,
      waitMs: 0,
      pollMs: 0,
      sleep: async () => {},
    };
    assert.equal(await quitProcessWin('Cursor.exe', deps), false);
    running = false;
    assert.equal(await quitProcessWin('Cursor.exe', deps), true);
  });
});

describe('memoizeExeWithTtl', () => {
  it('caches the result until the TTL expires', () => {
    let calls = 0;
    let now = 0;
    const resolve = memoizeExeWithTtl(
      () => {
        calls += 1;
        return `exe-${calls}`;
      },
      1000,
      () => now,
    );
    assert.equal(resolve(), 'exe-1');
    assert.equal(resolve(), 'exe-1', 'TTL 内不重解析');
    assert.equal(calls, 1);
    now = 1000;
    assert.equal(resolve(), 'exe-2');
    assert.equal(calls, 2);
  });

  // The sentinel is a boolean, not `at === 0`: when the injected clock starts at 0 the latter would misread "resolved" as "not resolved"
  it('still caches when the injected clock starts at 0', () => {
    let calls = 0;
    const resolve = memoizeExeWithTtl(
      () => {
        calls += 1;
        return undefined;
      },
      1000,
      () => 0,
    );
    resolve();
    resolve();
    assert.equal(calls, 1);
  });

  it('remembers a negative result (no exe: do not re-run the registry every reconnect)', () => {
    let calls = 0;
    const resolve = memoizeExeWithTtl(
      () => {
        calls += 1;
        return undefined;
      },
      1000,
      () => 5,
    );
    assert.equal(resolve(), undefined);
    assert.equal(resolve(), undefined);
    assert.equal(calls, 1);
  });
});

describe('openCursorWithCdpWin', () => {
  it('spawns the resolved exe detached with the debug port', async () => {
    const spawned: Array<[string, string[]]> = [];
    await openCursorWithCdpWin(0, {
      findExe: () => 'C:\\prog\\cursor\\Cursor.exe',
      spawnDetached: (exe, args) => spawned.push([exe, args]),
      log: () => {},
    });
    assert.deepEqual(spawned, [['C:\\prog\\cursor\\Cursor.exe', ['--remote-debugging-port=0']]]);
  });

  it('reports a hard failure instead of silently returning when the exe is missing', async () => {
    const spawned: unknown[] = [];
    const logs: string[] = [];
    await openCursorWithCdpWin(0, {
      findExe: () => undefined,
      spawnDetached: (exe, args) => spawned.push([exe, args]),
      log: m => logs.push(m),
    });
    assert.deepEqual(spawned, [], '找不到 exe 时绝不能瞎 spawn');
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /not found/);
  });
});
