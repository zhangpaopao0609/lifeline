import type { spawnSync } from 'node:child_process';
import type { CodeBuddyCdpRelaunchDeps } from '../packages/agent/src/drivers/codebuddy/relaunch.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  DARWIN_PS_CACHE_MS,
  isDarwinProcessRunning,
  isIdeUpdaterRunningDarwin,
  quitProcessWin,
  resetDarwinProcessCache,
} from '../packages/agent/src/cdp/relaunch-engine.js';
import {

  codeBuddyFamilyImageNames,
  createCodeBuddyCdpRelauncher,
  createWinFamilyQuit,
  defaultFindCodeBuddyExe,
  isCodeBuddyMainCommand,
  isCodeBuddyRunningWin,
  openCodeBuddyWithCdpWin,
  pickCodeBuddyQuitImagesWin,
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

  // VSCode (Code.exe) joins the family ONLY through the plugin gate — an
  // ungated match would make every plain-VSCode machine "CodeBuddy running".
  it('counts Code.exe only when the plugin gate is on', () => {
    const onlyVscode = fakeRun('"Code.exe","1","Console","1","1 K"');
    assert.equal(isCodeBuddyRunningWin({ run: onlyVscode }), false);
    assert.equal(isCodeBuddyRunningWin({ run: onlyVscode }, { vscodePlugin: true }), true);
  });
});

describe('codeBuddyFamilyImageNames', () => {
  it('gates Code.exe into the family image list', () => {
    assert.deepEqual(codeBuddyFamilyImageNames(false), ['CodeBuddy CN.exe', 'CodeBuddy.exe']);
    assert.deepEqual(codeBuddyFamilyImageNames(true), ['CodeBuddy CN.exe', 'CodeBuddy.exe', 'Code.exe']);
  });
});

describe('pickCodeBuddyQuitImagesWin', () => {
  const running = (...names: string[]) => (image: string) => names.includes(image);

  // Killing the whole family closes a window the slot is not using, and the poll
  // then waits on something it never asked to close.
  it('picks the standalone IDE and leaves VSCode alone when both hosts are running', () => {
    assert.deepEqual(
      pickCodeBuddyQuitImagesWin(running('CodeBuddy CN.exe', 'Code.exe'), true),
      ['CodeBuddy CN.exe'],
    );
  });

  it('never picks Code.exe without the plugin gate', () => {
    assert.deepEqual(pickCodeBuddyQuitImagesWin(running('Code.exe'), false), []);
  });

  it('picks Code.exe when it is the only family member (plugin-only machine)', () => {
    assert.deepEqual(pickCodeBuddyQuitImagesWin(running('Code.exe'), true), ['Code.exe']);
  });

  it('returns nothing when the family is not running (quit becomes a no-op, not a failure)', () => {
    assert.deepEqual(pickCodeBuddyQuitImagesWin(running(), true), []);
  });
});

describe('createWinFamilyQuit', () => {
  // Shipped bug pinned here: `taskkill` got "CodeBuddy only" while the poll
  // predicate counted `Code.exe`, so a live VSCode held the quit open until the
  // 25s deadline → skipped-quit-pending → the reopen never ran.
  function harness(alive: string[], vscodePlugin = true) {
    const killed: string[][] = [];
    const quitter = createWinFamilyQuit({
      vscodePlugin,
      isRunning: image => alive.includes(image),
      quit: async (images) => {
        killed.push([...images]);
        return true;
      },
    });
    return { quitter, killed };
  }

  it('closes only the standalone IDE, and does not reopen VSCode afterwards', async () => {
    const { quitter, killed } = harness(['CodeBuddy CN.exe', 'Code.exe']);
    assert.equal(await quitter.quit(), true);
    assert.deepEqual(killed, [['CodeBuddy CN.exe']]);
    assert.equal(quitter.lastQuitVscode(), false);
  });

  it('closes VSCode alone on a plugin-only machine, and reopens that one', async () => {
    const { quitter, killed } = harness(['Code.exe']);
    assert.equal(await quitter.quit(), true);
    assert.deepEqual(killed, [['Code.exe']]);
    assert.equal(quitter.lastQuitVscode(), true);
  });

  it('is a no-op when nothing is running, and does not claim it closed VSCode', async () => {
    const { quitter, killed } = harness([]);
    assert.equal(await quitter.quit(), true);
    assert.deepEqual(killed, []);
    assert.equal(quitter.lastQuitVscode(), false);
  });

  it('never closes Code.exe on a machine without the plugin', async () => {
    const { quitter, killed } = harness(['Code.exe'], false);
    assert.equal(await quitter.quit(), true);
    assert.deepEqual(killed, []);
  });
});

describe('quitProcessWin kill set == wait set', () => {
  // What the factory hands to the engine: only the images it killed. A live
  // `Code.exe` must not hold a CodeBuddy-only quit open.
  it('succeeds while an unrelated family image is still alive', async () => {
    const seen: string[][] = [];
    const run = ((cmd: string, args: string[] = []) => {
      seen.push([cmd, ...args]);
      if (cmd === 'taskkill')
        return { stdout: '', stderr: '', error: undefined, status: 0 };
      const image = args.find(a => a.startsWith('IMAGENAME eq '))?.slice('IMAGENAME eq '.length) ?? '';
      return image === 'Code.exe'
        ? { stdout: '"Code.exe","1","Console","1","1 K"', stderr: '', error: undefined, status: 0 }
        : { stdout: 'INFO: No tasks are running which match the specified criteria.', stderr: '', error: undefined, status: 0 };
    }) as unknown as typeof spawnSync;

    const ok = await quitProcessWin(['CodeBuddy CN.exe'], {
      run,
      now: () => 0,
      waitMs: 10,
      pollMs: 1,
      sleep: async () => {},
    });
    assert.equal(ok, true);
    assert.deepEqual(seen.filter(c => c[0] === 'taskkill'), [['taskkill', '/IM', 'CodeBuddy CN.exe']]);
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

/**
 * Measured 2026-11-05: CodeBuddy CN's main process is invisible to `pgrep` (any
 * pattern, even `-x Electron`) while `ps -axo pid=,command=` lists it. With only
 * `pgrep`, `isCodeBuddyRunning` said "not running" for a running IDE, so the
 * family predicate was satisfied by VSCode and the relauncher quit **VSCode**
 * instead of the IDE that had no debug port.
 */
describe('isDarwinProcessRunning', () => {
  type Handler = { status?: number; stdout?: string } | 'throw';

  function fakeSpawn(handlers: { pgrep?: (args: string[]) => Handler; ps?: () => Handler }, calls?: string[]) {
    return ((cmd: string, args: string[] = []) => {
      calls?.push(cmd);
      const h = cmd === 'pgrep' ? handlers.pgrep?.(args) : handlers.ps?.();
      if (h === 'throw')
        throw new Error(`spawnSync ${cmd} ENOENT`);
      return { status: h?.status ?? 1, stdout: h?.stdout ?? '', stderr: '', error: undefined };
    }) as unknown as typeof spawnSync;
  }

  beforeEach(() => resetDarwinProcessCache());

  it('takes the pgrep answer without spawning ps', () => {
    const calls: string[] = [];
    const run = fakeSpawn({
      pgrep: () => ({ status: 0, stdout: '123\n' }),
      ps: () => ({ stdout: '' }),
    }, calls);
    assert.equal(isDarwinProcessRunning('X.app/Contents/MacOS/', { run }), true);
    assert.deepEqual(calls, ['pgrep']);
  });

  it('finds the process through ps when pgrep cannot see it', () => {
    const run = fakeSpawn({
      pgrep: () => ({ status: 1, stdout: '' }),
      ps: () => ({
        stdout: '  8457 /Applications/CodeBuddy CN.app/Contents/MacOS/Electron --remote-debugging-port=9223\n',
      }),
    });
    assert.equal(isDarwinProcessRunning('CodeBuddy CN.app/Contents/MacOS/', { run }), true);
  });

  it('is false only when neither tool sees it', () => {
    const run = fakeSpawn({
      pgrep: () => ({ status: 1, stdout: '' }),
      ps: () => ({ stdout: '  1 /sbin/launchd\n' }),
    });
    assert.equal(isDarwinProcessRunning('CodeBuddy CN.app/Contents/MacOS/', { run }), false);
  });

  it('is false when ps also fails (never throws to the caller)', () => {
    const run = fakeSpawn({ pgrep: () => 'throw', ps: () => 'throw' });
    assert.equal(isDarwinProcessRunning('CodeBuddy CN.app/Contents/MacOS/', { run }), false);
  });

  it('serves every pattern from one ps snapshot for DARWIN_PS_CACHE_MS', () => {
    let psCalls = 0;
    let now = 0;
    const run = fakeSpawn({
      pgrep: () => ({ status: 1 }),
      ps: () => {
        psCalls += 1;
        return { stdout: '  1 /sbin/launchd\n' };
      },
    });
    const deps = { run, now: () => now };

    isDarwinProcessRunning('A.app/Contents/MacOS/', deps);
    isDarwinProcessRunning('B.app/Contents/MacOS/', deps);
    assert.equal(psCalls, 1, '同一 tick 内的两次判定共用一次 ps');

    now = DARWIN_PS_CACHE_MS;
    isDarwinProcessRunning('C.app/Contents/MacOS/', deps);
    assert.equal(psCalls, 2, '过期后重新取快照');
  });

  // The updater pattern is anchored with `(^|/)`, so the ps fallback must match
  // per line — a plain `includes` would miss it on multi-line output.
  it('matches the anchored updater pattern line by line', () => {
    const run = fakeSpawn({
      pgrep: () => ({ status: 1 }),
      ps: () => ({
        stdout: '  1 /sbin/launchd\n 99 /Applications/Cursor.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt\n',
      }),
    });
    assert.equal(isIdeUpdaterRunningDarwin('Cursor', { run }), true);
    assert.equal(isIdeUpdaterRunningDarwin('CodeBuddy', { run }), false);
  });
});
