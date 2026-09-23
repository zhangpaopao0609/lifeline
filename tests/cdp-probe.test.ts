// Types only: `spawnSync` is the **injection point** type; runtime does not import child_process (tests do not actually run commands)
import type { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appPathOf,
  describePortOccupant,
  identityOf,
  parseBrowserUuid,
  parseOccupantLsof,
  parseOccupantNetstat,
  parseTasklistImage,
  probeCdpEndpoint,
} from '../packages/agent/src/cdp/probe.js';

const CURSOR_UA = 'Mozilla/5.0 Chrome/148.0.7778.280 Cursor/3.20.21';
const CHROME_UA = 'Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36';
const VSCODE_UA = 'Mozilla/5.0 Electron/37.0.0 Code/1.96.0';
const BUDDY_UA = 'Mozilla/5.0 Chrome/138.0.7204.251 CodeBuddyCN/1.106.1';
const WB = 'vscode-file://vscode-app/x/out/vs/code/electron-sandbox/workbench/workbench.html';
/** Real VS Code workbench path (spaces percent-encoded) */
const VSCODE_WB = 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html';
const UUID_A = 'f5011f9f-cd9e-4a7b-a191-3373499fcd6a';
const UUID_B = '5763f93b-4027-46a0-857b-2a37c26a7619';

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchMap(routes: Record<string, () => Response | Promise<Response> | never>): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url);
    const hit = routes[key];
    if (!hit) {
      const err = new Error('fetch failed');
      (err as Error & { cause: { code: string } }).cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    return hit();
  }) as typeof fetch;
}

const workbench = {
  id: 't1',
  type: 'page',
  title: 'app',
  url: WB,
  webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/t1',
};

describe('identityOf', () => {
  it('matches Cursor and CodeBuddy tokens (slashes optional, so a rename still matches)', () => {
    assert.equal(identityOf(CURSOR_UA, 'cursor'), 'match');
    assert.equal(identityOf(BUDDY_UA, 'codebuddy'), 'match');
    // Relaxed to not require a slash: renamed products like CursorNext/ and CodeBuddyAI/ still match
    assert.equal(identityOf('Mozilla/5.0 CursorNext/1.0 Chrome/160', 'cursor'), 'match');
    assert.equal(identityOf('Mozilla/5.0 CodeBuddyAI/2.0', 'codebuddy'), 'match');
    assert.equal(identityOf(CURSOR_UA, 'codebuddy'), 'foreign');
  });
  it('is unknown when UA is missing or unrecognisable', () => {
    assert.equal(identityOf(undefined, 'cursor'), 'unknown');
    assert.equal(identityOf('', 'cursor'), 'unknown');
    assert.equal(identityOf('   ', 'cursor'), 'unknown');
    assert.equal(identityOf('Mozilla/5.0 SomethingNew/1.0', 'cursor'), 'unknown');
  });
  it('flags vanilla Chrome and VS Code as foreign on the cursor slot', () => {
    assert.equal(identityOf(CHROME_UA, 'cursor'), 'foreign');
    assert.equal(identityOf(VSCODE_UA, 'cursor'), 'foreign');
  });
});

describe('probeCdpEndpoint', () => {
  const url = 'http://127.0.0.1:9222';
  it('maps ECONNREFUSED to no-listener', async () => {
    const r = await probeCdpEndpoint(url, 'cursor', { fetch: fetchMap({}) });
    assert.equal(r.kind, 'no-listener');
  });
  it('maps AbortError / timeout to unknown, not no-listener', async () => {
    const fetch = (async () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'unknown');
  });
  it('maps HTTP 404 to not-cdp http and does not call /json/version', async () => {
    let versionHits = 0;
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(404, { error: 'nope' }),
      [`${url}/json/version`]: () => { versionHits += 1; return jsonResp(200, {}); },
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch, lookupOccupant: () => 'node (pid 1)' });
    assert.equal(r.kind, 'not-cdp');
    assert.equal(r.notCdpCause, 'http');
    assert.equal(r.occupant, 'node (pid 1)');
    assert.equal(versionHits, 0);
  });
  it('maps empty list + Cursor UA to no-window', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, []),
      [`${url}/json/version`]: () => jsonResp(200, { 'Browser': 'Chrome/148', 'User-Agent': CURSOR_UA }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'no-window');
  });
  it('maps empty list + Chrome UA to not-cdp foreign', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, []),
      [`${url}/json/version`]: () => jsonResp(200, { 'Browser': 'Chrome/148', 'User-Agent': CHROME_UA }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'not-cdp');
    assert.equal(r.notCdpCause, 'foreign');
    assert.equal(r.browser, 'Chrome/148');
  });
  it('maps empty list + version 200 without User-Agent to unknown', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, []),
      [`${url}/json/version`]: () => jsonResp(200, { Browser: 'Chrome/148' }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'unknown');
  });
  it('maps empty list + version fetch fail to unknown', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, []),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'unknown');
  });
  it('does not treat a VS Code workbench as Cursor ok (rule 2: 安装路径)', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [{ ...workbench, url: VSCODE_WB }]),
      [`${url}/json/version`]: () => jsonResp(200, { 'Browser': 'Chrome/148', 'User-Agent': VSCODE_UA }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'not-cdp');
    assert.equal(r.notCdpCause, 'foreign');
  });
  it('returns ok for a workbench even when the UA is unrecognisable (a rename must not block everyone)', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [workbench]),
      [`${url}/json/version`]: () => jsonResp(200, { 'User-Agent': 'Mozilla/5.0 SomethingNew/2.0' }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'ok');
  });
  it('returns ok for a workbench when /json/version is unreachable', async () => {
    const fetch = fetchMap({ [`${url}/json`]: () => jsonResp(200, [workbench]) });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'ok');
  });
  it('accepts a renamed UA that keeps Chrome/ when the app path is not a known other app', async () => {
    // This is leftover from R2: a real product-rename UA usually still carries Chrome/, just not Cursor.
    // With a connectable workbench we now only trust the **install path**; UA is no longer the "can we connect" criterion.
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [workbench]),
      [`${url}/json/version`]: () => jsonResp(200, {
        'User-Agent': 'Mozilla/5.0 Anysphere/1.0 Chrome/160.0.0.0 Safari/537.36',
      }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'ok');
  });
  it('accepts the endpoint when the browser uuid matches, whatever the UA says', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [workbench]),
      [`${url}/json/version`]: () => jsonResp(200, {
        'User-Agent': 'Mozilla/5.0 Anysphere/1.0 Chrome/160.0.0.0 Safari/537.36',
        'webSocketDebuggerUrl': `ws://127.0.0.1:9222/devtools/browser/${UUID_A}`,
      }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch, expect: { browserUuid: UUID_A } });
    assert.equal(r.kind, 'ok');
    assert.equal(r.browserUuid, UUID_A);
  });
  it('reports not-cdp when the browser uuid disagrees with the file', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [workbench]),
      [`${url}/json/version`]: () => jsonResp(200, {
        'User-Agent': CURSOR_UA,
        'webSocketDebuggerUrl': `ws://127.0.0.1:9222/devtools/browser/${UUID_B}`,
      }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch, expect: { browserUuid: UUID_A } });
    assert.equal(r.kind, 'not-cdp');
    assert.equal(r.notCdpCause, 'foreign');
    assert.equal(r.browserUuid, UUID_B);
  });
  it('never treats a missing uuid on either side as a mismatch', async () => {
    // No uuid in the file (or /json/version gave no ws url) → this layer does not apply and must not block
    const noVersionUuid = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [workbench]),
      [`${url}/json/version`]: () => jsonResp(200, { 'User-Agent': CURSOR_UA }),
    });
    assert.equal(
      (await probeCdpEndpoint(url, 'cursor', { fetch: noVersionUuid, expect: { browserUuid: UUID_A } })).kind,
      'ok',
    );
    const noExpectedUuid = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [workbench]),
      [`${url}/json/version`]: () => jsonResp(200, {
        'User-Agent': CURSOR_UA,
        'webSocketDebuggerUrl': `ws://127.0.0.1:9222/devtools/browser/${UUID_A}`,
      }),
    });
    assert.equal((await probeCdpEndpoint(url, 'cursor', { fetch: noExpectedUuid })).kind, 'ok');
  });
  it('maps empty list + unrecognisable UA to unknown, not not-cdp', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, []),
      [`${url}/json/version`]: () => jsonResp(200, { 'User-Agent': 'Mozilla/5.0 SomethingNew/2.0' }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'unknown');
  });
  it('returns ok when workbench has ws url and Cursor UA', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [workbench]),
      [`${url}/json/version`]: () => jsonResp(200, { 'User-Agent': CURSOR_UA }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'ok');
    assert.equal(r.target?.id, 't1');
  });
  it('maps iframe-only + matching UA to no-workbench', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [{ type: 'iframe', title: 'x', url: 'vscode-webview://x' }]),
      [`${url}/json/version`]: () => jsonResp(200, { 'User-Agent': CURSOR_UA }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'no-workbench');
  });
  it('maps workbench page without ws url + matching UA to no-workbench', async () => {
    const fetch = fetchMap({
      [`${url}/json`]: () => jsonResp(200, [{ id: 't', type: 'page', title: 'a', url: WB }]),
      [`${url}/json/version`]: () => jsonResp(200, { 'User-Agent': CURSOR_UA }),
    });
    const r = await probeCdpEndpoint(url, 'cursor', { fetch });
    assert.equal(r.kind, 'no-workbench');
  });
});

describe('appPathOf / parseBrowserUuid', () => {
  it('decodes the app path out of a vscode-file url', () => {
    assert.match(
      appPathOf('vscode-file://vscode-app/Applications/CodeBuddy%20CN.app/Contents/Resources/app/out/x.html'),
      /CodeBuddy CN\.app/,
    );
    assert.equal(appPathOf('https://example.com/x'), '', '不是 vscode-file 的 URL → 空串（认不出，别乱判）');
    assert.equal(appPathOf(''), '');
  });
  it('reads the browser uuid from the version ws url — strictly', () => {
    assert.equal(parseBrowserUuid(`ws://127.0.0.1:9222/devtools/browser/${UUID_A}`), UUID_A);
    assert.equal(parseBrowserUuid('ws://127.0.0.1:9222/devtools/browser/abc'), undefined, '太短 → 不认');
    // Why parse strictly: a non-canonical value must count as "unparseable", else it is compared as the "expected id",
    // turning "unread" into "mismatch" → blocking a healthy Cursor (hit live: the file had restored written in)
    assert.equal(parseBrowserUuid('ws://127.0.0.1:9222/devtools/browser/restored'), undefined);
    assert.equal(parseBrowserUuid('ws://127.0.0.1:9222/devtools/browser/poisoned'), undefined);
    assert.equal(parseBrowserUuid(''), undefined);
    assert.equal(parseBrowserUuid(undefined), undefined);
  });
});

describe('parseOccupantLsof', () => {
  it('reads COMMAND and PID from the first LISTEN row', () => {
    const stdout = 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nGoogle  65600 me   32u  IPv4 0x0      0t0  TCP 127.0.0.1:9222 (LISTEN)\n';
    assert.equal(parseOccupantLsof(stdout), 'Google (pid 65600)');
  });
});

// Windows uses `netstat -ano` + `tasklist`. The text below is copied **verbatim from a live machine**.
// Pitfall: the same port also appears as TIME_WAIT rows, and those rows have PID 0.
const NETSTAT = [
  '  TCP    127.0.0.1:54464        0.0.0.0:0              LISTENING       7824',
  '  TCP    127.0.0.1:54811        127.0.0.1:54464        TIME_WAIT       0',
  '  TCP    127.0.0.1:54814        127.0.0.1:54464        TIME_WAIT       0',
].join('\r\n');

describe('parseOccupantNetstat', () => {
  it('picks the LISTENING row, never a TIME_WAIT row (whose PID is 0)', () => {
    assert.equal(parseOccupantNetstat(NETSTAT, 54464), '7824');
  });

  it('does not treat a port that only appears as the REMOTE port as listened-on', () => {
    // 54811 only appears in the "remote port" slot (TIME_WAIT); nobody on this machine is listening on it
    assert.equal(parseOccupantNetstat(NETSTAT, 54811), undefined);
  });

  it('returns undefined when nothing listens on that port', () => {
    assert.equal(parseOccupantNetstat(NETSTAT, 9222), undefined);
    assert.equal(parseOccupantNetstat('', 54464), undefined);
    assert.equal(parseOccupantNetstat('  TCP    0.0.0.0:80    0.0.0.0:0    ESTABLISHED    1', 80), undefined);
  });

  it('ignores a zero PID even on a LISTENING row', () => {
    assert.equal(
      parseOccupantNetstat('  TCP    0.0.0.0:80        0.0.0.0:0              LISTENING       0', 80),
      undefined,
    );
  });

  it('does not match a longer port that merely ends with the same digits', () => {
    // 8080 must not be hit by :80
    assert.equal(
      parseOccupantNetstat('  TCP    127.0.0.1:8080        0.0.0.0:0              LISTENING       99', 80),
      undefined,
    );
  });

  it('skips the header row and handles IPv6 local addresses', () => {
    const withHeader = [
      '活动连接',
      '',
      '  协议  本地地址          外部地址        状态           PID',
      '  TCP    [::]:9222          [::]:0          LISTENING       42',
    ].join('\r\n');
    assert.equal(parseOccupantNetstat(withHeader, 9222), '42');
  });

  it('returns the first LISTENING row when several bind the same port', () => {
    const two = [
      '  TCP    0.0.0.0:9222          0.0.0.0:0              LISTENING       7',
      '  TCP    127.0.0.1:9222        0.0.0.0:0              LISTENING       9',
    ].join('\r\n');
    assert.equal(parseOccupantNetstat(two, 9222), '7');
  });

  it('rejects a truncated row (a real LISTENING line has 5 columns)', () => {
    assert.equal(parseOccupantNetstat('  TCP    127.0.0.1:9222    LISTENING    7824', 9222), undefined);
  });
});

// `spawnSync` is injectable: otherwise the win32 chain (netstat → tasklist) **never runs a single line** in unit tests.
// Note: these cases **do not actually call** netstat / tasklist.
function fakeRun(map: Record<string, { stdout?: string; error?: Error }>) {
  return ((cmd: string, args: string[] = []) => {
    const hit = map[cmd];
    void args;
    return { stdout: hit?.stdout ?? '', stderr: '', error: hit?.error };
  }) as unknown as typeof spawnSync;
}

describe('describePortOccupant', () => {
  const noWarn = () => {};
  const winDeps = (run: typeof spawnSync) => ({ run, platform: 'win32' as const, warn: noWarn });

  it('names the occupant via netstat + tasklist on win32', () => {
    const run = fakeRun({
      netstat: { stdout: NETSTAT },
      tasklist: { stdout: '"Cursor.exe","7824","Console","1","311,988 K"\r\n' },
    });
    assert.equal(describePortOccupant(54464, winDeps(run)), 'Cursor.exe (pid 7824)');
  });

  it('queries netstat -ano, then tasklist with the pid netstat gave', () => {
    const seen: string[][] = [];
    const opts: unknown[] = [];
    const run = ((cmd: string, args: string[] = [], o?: unknown) => {
      seen.push([cmd, ...args]);
      opts.push(o);
      return {
        stdout: cmd === 'netstat' ? NETSTAT : '"Cursor.exe","7824"',
        stderr: '',
        error: undefined,
      };
    }) as unknown as typeof spawnSync;
    describePortOccupant(54464, winDeps(run));
    assert.deepEqual(seen[0], ['netstat', '-ano']);
    assert.deepEqual(seen[1], ['tasklist', '/FI', 'PID eq 7824', '/FO', 'CSV', '/NH']);
    // Sync-spawn budget and hidden window are part of the contract too (diagnostic copy is not worth pinning the event loop)
    for (const o of opts) {
      assert.equal((o as { timeout?: number }).timeout, 1000);
      assert.equal((o as { windowsHide?: boolean }).windowsHide, true);
    }
  });

  it('degrades to a bare pid when the image name cannot be read', () => {
    const run = fakeRun({
      netstat: { stdout: NETSTAT },
      tasklist: { stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' },
    });
    assert.equal(describePortOccupant(54464, winDeps(run)), 'pid 7824');
  });

  it('returns undefined and warns once when netstat is unavailable', () => {
    const warns: string[] = [];
    const run = fakeRun({ netstat: { error: new Error('spawnSync netstat ENOENT') } });
    assert.equal(
      describePortOccupant(54464, { run, platform: 'win32', warn: m => warns.push(m) }),
      undefined,
    );
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /netstat unavailable/);
  });

  it('returns undefined when nothing listens on that port', () => {
    const run = fakeRun({ netstat: { stdout: NETSTAT } });
    assert.equal(describePortOccupant(9222, winDeps(run)), undefined);
  });

  it('uses lsof (and only lsof) on POSIX platforms', () => {
    const seen: string[] = [];
    const run = ((cmd: string) => {
      seen.push(cmd);
      return { stdout: 'COMMAND PID USER\nGoogle 65600 me\n', stderr: '', error: undefined };
    }) as unknown as typeof spawnSync;
    assert.equal(describePortOccupant(9222, { run, platform: 'linux', warn: noWarn }), 'Google (pid 65600)');
    assert.deepEqual(seen, ['lsof']);
  });
});

describe('parseTasklistImage', () => {
  it('strips the quotes off the CSV first field', () => {
    assert.equal(parseTasklistImage('"Cursor.exe","7824","Console","1","311,988 K"'), 'Cursor.exe');
  });

  it('keeps image names that contain spaces', () => {
    assert.equal(
      parseTasklistImage('"CodeBuddy CN.exe","19036","Console","1","594,532 K"'),
      'CodeBuddy CN.exe',
    );
  });

  // On no match tasklist prints this fixed copy — parse must return undefined, not treat it as "there is a process by that name"
  it('returns undefined for the no-match banner and for empty input', () => {
    assert.equal(parseTasklistImage('INFO: No tasks are running which match the specified criteria.'), undefined);
    assert.equal(parseTasklistImage(''), undefined);
  });

  it('returns undefined for non-CSV output (we did not ask for /FO CSV)', () => {
    assert.equal(parseTasklistImage('Cursor.exe    7824 Console    1    311,988 K'), undefined);
  });
});
