import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { canControlIde, detectLiveIdes } from '../packages/agent/src/live-ides.js';

describe('canControlIde', () => {
  it('is true everywhere except Linux', () => {
    assert.equal(canControlIde('darwin', {}), true);
    assert.equal(canControlIde('win32', {}), true);
    assert.equal(canControlIde('linux', {}), false, 'Linux 只做数据源');
  });

  it('does not depend on the desktop environment — it is a product-scope decision', () => {
    // We used to guess "does this machine have a GUI" from DISPLAY, but systemd-launched
    // processes lack that variable → Linux desktop users were classified as a data source
    // and the machine silently went read-only (review item 1). Now independent of desktop.
    assert.equal(canControlIde('linux', { DISPLAY: ':0' }), false);
    assert.equal(canControlIde('linux', { WAYLAND_DISPLAY: 'wayland-0' }), false);
  });

  it('honours the escape hatch', () => {
    assert.equal(canControlIde('linux', { LIFELINE_LINUX_CDP: '1' }), true);
    assert.equal(canControlIde('linux', { LIFELINE_LINUX_CDP: '0' }), false);
  });

  // The criterion is an **explicit list**, not `platform !== 'linux'`: unknown platforms
  // have unverified real capability; defaulting to allow means every new platform would
  // silently be allowed.
  it('defaults unknown platforms to content-source, not to live control', () => {
    assert.equal(canControlIde('freebsd', {}), false);
    assert.equal(canControlIde('aix', {}), false);
  });
});

describe('detectLiveIdes', () => {
  it('darwin sees Cursor.app', () => {
    const ids = detectLiveIdes(p => p === '/Applications/Cursor.app', '/Users/x', 'darwin');
    assert.deepEqual(ids, ['cursor']);
  });

  // Expected values must be built with join: a hardcoded `/Users/x/...` assertion fails on
  // Windows (product code is join(home, …), which yields backslashes), which would make the
  // whole suite unrunnable on Windows.
  it('darwin sees Cursor.app under the user Applications folder', () => {
    const userApp = join('/Users/x', 'Applications', 'Cursor.app');
    const ids = detectLiveIdes(p => p === userApp, '/Users/x', 'darwin');
    assert.deepEqual(ids, ['cursor']);
  });

  it('darwin sees CodeBuddy CN.app and CodeBuddy.app', () => {
    assert.deepEqual(
      detectLiveIdes(p => p === '/Applications/CodeBuddy CN.app', '/Users/x', 'darwin'),
      ['codebuddy'],
    );
    assert.deepEqual(
      detectLiveIdes(p => p === '/Applications/CodeBuddy.app', '/Users/x', 'darwin'),
      ['codebuddy'],
    );
    assert.deepEqual(
      detectLiveIdes(
        p => p === join('/Users/x', 'Applications', 'CodeBuddy CN.app'),
        '/Users/x',
        'darwin',
      ),
      ['codebuddy'],
    );
  });

  it('reports both IDEs when both GUI apps exist', () => {
    const present = new Set(['/Applications/Cursor.app', '/Applications/CodeBuddy.app']);
    const ids = detectLiveIdes(p => present.has(p), '/Users/x', 'darwin');
    assert.deepEqual(ids, ['cursor', 'codebuddy']);
  });

  it('returns [] on Linux — that agent only reads data, so the result is unused', () => {
    // Deliberately omit Linux desktop package paths: adding them would not be used and
    // would only make people think Linux can control the IDE.
    const paths = [
      '/usr/share/cursor/cursor',
      '/opt/Cursor/cursor',
      '/usr/share/applications/cursor.desktop',
      '/opt/CodeBuddy CN',
      '/usr/share/applications/codebuddy.desktop',
    ];
    for (const p of paths) {
      assert.deepEqual(detectLiveIdes(x => x === p, '/home/u', 'linux'), [], p);
    }
  });

  it('ignores cursor-server and state.vscdb', () => {
    const ids = detectLiveIdes(
      p => p.includes('.cursor-server') || p.includes('state.vscdb'),
      '/home/u',
      'linux',
    );
    assert.deepEqual(ids, []);
  });

  // Windows: paths come from win-paths.ts (measured: both IDEs install under LOCALAPPDATA\Programs)
  describe('win32', () => {
    const ENV = { APPDATA: 'C:\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\u\\AppData\\Local' };
    const HOME = 'C:\\u';
    const perUserCursor = 'C:\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe';
    const perUserCodeBuddy = 'C:\\u\\AppData\\Local\\Programs\\CodeBuddy CN\\CodeBuddy CN.exe';

    it('sees the per-user Cursor install', () => {
      assert.deepEqual(detectLiveIdes(p => p === perUserCursor, HOME, 'win32', ENV), ['cursor']);
    });

    it('sees the per-user CodeBuddy CN install', () => {
      assert.deepEqual(detectLiveIdes(p => p === perUserCodeBuddy, HOME, 'win32', ENV), ['codebuddy']);
    });

    it('sees a machine-wide install under Program Files', () => {
      assert.deepEqual(
        detectLiveIdes(p => p === 'C:\\Program Files\\Cursor\\Cursor.exe', HOME, 'win32', ENV),
        ['cursor'],
      );
    });

    it('sees a 32-bit-style install under Program Files (x86)', () => {
      assert.deepEqual(
        detectLiveIdes(p => p === 'C:\\Program Files (x86)\\Cursor\\Cursor.exe', HOME, 'win32', ENV),
        ['cursor'],
      );
    });

    it('reports both when both are installed, and [] when neither is', () => {
      const present = new Set([perUserCursor, perUserCodeBuddy]);
      assert.deepEqual(detectLiveIdes(p => present.has(p), HOME, 'win32', ENV), ['cursor', 'codebuddy']);
      assert.deepEqual(detectLiveIdes(() => false, HOME, 'win32', ENV), []);
    });
  });
});
