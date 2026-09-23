import type { ProbeResult } from '../packages/agent/src/cdp/probe.js';
import type { AgentConfig } from '../packages/agent/src/types.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { CDPBridge } from '../packages/agent/src/cdp/bridge.js';
import {
  clearEndpointCache,
  codeBuddyActivePortCandidates,
  cursorActivePortCandidates,
  parseDevToolsActivePort,
  parseDevToolsActivePortUuid,
  resolveEndpoint,
} from '../packages/agent/src/cdp/endpoint.js';
import { probeCdpEndpoint } from '../packages/agent/src/cdp/probe.js';

const CHROME_UA = 'Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36';
const VSCODE_UA = 'Mozilla/5.0 Electron/37.0.0 Code/1.96.0';
const WB = 'vscode-file://vscode-app/x/out/vs/code/electron-sandbox/workbench/workbench.html';
const FILE_PORT = 52464;
const FILE_URL = `http://127.0.0.1:${FILE_PORT}`;
const CONFIG_URL = 'http://127.0.0.1:9222';
const FILE_PATH = '/tmp/Cursor/DevToolsActivePort';

const workbench = {
  id: 't1',
  type: 'page',
  title: 'app',
  url: WB,
  webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/t1',
};

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

function probeWithFetch(fetch: typeof fetch): typeof probeCdpEndpoint {
  return (url, ide, opts) => probeCdpEndpoint(url, ide, { ...opts, fetch });
}

function recordingProbe(inner: typeof probeCdpEndpoint): {
  probe: typeof probeCdpEndpoint;
  calls: ProbeResult[];
} {
  const calls: ProbeResult[] = [];
  const probe: typeof probeCdpEndpoint = async (url, ide, opts) => {
    const result = await inner(url, ide, opts);
    calls.push(result);
    return result;
  };
  return { probe, calls };
}

function stubProbe(kind: ProbeResult['kind'], extra: Partial<ProbeResult> = {}): typeof probeCdpEndpoint {
  return async url => ({
    kind,
    cdpUrl: url,
    port: 1,
    detail: kind,
    at: 1,
    ...extra,
  });
}

beforeEach(() => {
  clearEndpointCache();
});

describe('parseDevToolsActivePort', () => {
  it('reads the first line of a two-line Chromium file', () => {
    assert.equal(parseDevToolsActivePort('9222\n/devtools/browser/5763f93b-aaaa\n'), 9222);
  });

  it('accepts a file with only the port line', () => {
    assert.equal(parseDevToolsActivePort('52464'), 52464);
  });

  it('returns undefined for empty, non-numeric, 0, 65536, and -1', () => {
    assert.equal(parseDevToolsActivePort(''), undefined);
    assert.equal(parseDevToolsActivePort('\n'), undefined);
    assert.equal(parseDevToolsActivePort('abc\n/devtools/browser/x'), undefined);
    assert.equal(parseDevToolsActivePort('0\n/devtools/browser/x'), undefined);
    assert.equal(parseDevToolsActivePort('65536'), undefined);
    assert.equal(parseDevToolsActivePort('-1'), undefined);
  });

  it('tolerates CRLF and accepts 1..65535', () => {
    assert.equal(parseDevToolsActivePort('9223\r\n/devtools/browser/85cc1ba0\r\n'), 9223);
    assert.equal(parseDevToolsActivePort('1\r\n'), 1);
    assert.equal(parseDevToolsActivePort('65535'), 65535);
  });
});

describe('cursorActivePortCandidates', () => {
  it('reads the browser uuid from the second line, or undefined', () => {
    const UUID = 'f5011f9f-cd9e-4a7b-a191-3373499fcd6a';
    assert.equal(parseDevToolsActivePortUuid(`9222\n/devtools/browser/${UUID}\n`), UUID);
    assert.equal(parseDevToolsActivePortUuid('9222\n'), undefined);
    assert.equal(parseDevToolsActivePortUuid('9222\n/devtools/browser/abc'), undefined, '太短不算 uuid');
    // A non-canonical token must count as "unparseable" (this layer is N/A), else it is compared → blocking a healthy IDE
    assert.equal(parseDevToolsActivePortUuid('9222\n/devtools/browser/restored'), undefined);
    assert.equal(parseDevToolsActivePortUuid('9222\n/devtools/browser/poisoned'), undefined);
    assert.equal(parseDevToolsActivePortUuid('9222'), undefined);
  });

  // Always build expected values with join: production code is join(home, …) and yields backslashes on Windows,
  // so a hard-coded `/Users/me/...` in the assertion would fail the whole suite on Windows.
  it('points darwin at Application Support, never ~/.cursor', () => {
    const paths = cursorActivePortCandidates('/Users/me', 'darwin');
    assert.deepEqual(paths, [
      join('/Users/me', 'Library', 'Application Support', 'Cursor', 'DevToolsActivePort'),
    ]);
    assert.equal(paths.some(p => p.split(/[\\/]/).includes('.cursor')), false);
  });

  it('points linux at ~/.config/Cursor', () => {
    assert.deepEqual(cursorActivePortCandidates('/home/me', 'linux'), [
      join('/home/me', '.config', 'Cursor', 'DevToolsActivePort'),
    ]);
  });

  // Windows: measured Cursor DevToolsActivePort lives in userDataDir (%APPDATA%\Cursor)
  it('points win32 at %APPDATA%\\Cursor', () => {
    const env = { APPDATA: 'C:\\u\\AppData\\Roaming' };
    assert.deepEqual(cursorActivePortCandidates('C:\\u', 'win32', env), [
      'C:\\u\\AppData\\Roaming\\Cursor\\DevToolsActivePort',
    ]);
  });

  it('never returns a POSIX path on win32', () => {
    const env = { APPDATA: 'C:\\u\\AppData\\Roaming' };
    for (const p of cursorActivePortCandidates('C:\\u', 'win32', env)) {
      assert.equal(p.startsWith('.config') || p.includes('/.config/'), false, p);
      assert.equal(p.includes('/'), false, `win32 候选不该混进正斜杠: ${p}`);
    }
  });
});

describe('codeBuddyActivePortCandidates', () => {
  it('uses the same userDataDirs as argv, CN first', () => {
    const darwin = codeBuddyActivePortCandidates('/Users/me', 'darwin');
    assert.equal(
      darwin[0],
      join('/Users/me', 'Library', 'Application Support', 'CodeBuddy CN', 'DevToolsActivePort'),
    );
    assert.equal(
      darwin[1],
      join('/Users/me', 'Library', 'Application Support', 'CodeBuddy', 'DevToolsActivePort'),
    );
    assert.equal(darwin.every(p => p.endsWith('DevToolsActivePort')), true);

    const linux = codeBuddyActivePortCandidates('/home/me', 'linux');
    assert.equal(linux[0], join('/home/me', '.config', 'CodeBuddy CN', 'DevToolsActivePort'));
    assert.equal(linux[1], join('/home/me', '.config', 'CodeBuddy', 'DevToolsActivePort'));
  });

  // Measured: CodeBuddy --user-data-dir = %APPDATA%\CodeBuddy CN → the port file lives there too
  it('puts the win32 userDataDirs first, keeping the other platforms after', () => {
    const env = { APPDATA: 'C:\\u\\AppData\\Roaming' };
    const win = codeBuddyActivePortCandidates('C:\\u', 'win32', env);
    assert.equal(win[0], 'C:\\u\\AppData\\Roaming\\CodeBuddy CN\\DevToolsActivePort');
    assert.equal(win[1], 'C:\\u\\AppData\\Roaming\\CodeBuddy\\DevToolsActivePort');
    // Other platforms' candidates are still listed (symmetric with the darwin/linux "each lists the other") but ranked later
    assert.equal(win.length, 6);
  });

  // "Current platform first" is the **only** safety: `resolveEndpoint` takes the first readable file whose port parses
  // (including not-cdp / unknown), with no kinship check. So a cross-platform candidate, once read, is adopted —
  // this case pins that behavior so nobody assumes "kinship will save us" and shuffles the order.
  it('adopts the first readable candidate, so the current platform must come first', async () => {
    const env = { APPDATA: 'C:\\u\\AppData\\Roaming' };
    const candidates = codeBuddyActivePortCandidates('C:\\u', 'win32', env);
    const winPath = candidates[0]!;
    const linuxPath = candidates[2]!;
    const readable = new Map<string, string>([
      [winPath, '2222'],
      [linuxPath, '1111'],
    ]);
    const result = await resolveEndpoint({
      ide: 'codebuddy',
      configuredUrl: CONFIG_URL,
      probe: stubProbe('ok'),
      readFile: p => readable.get(p),
      candidates,
    });
    assert.equal(result.source, 'active-port-file');
    assert.equal(result.cdpUrl, 'http://127.0.0.1:2222', 'win32 的候选在前 → 采纳它，而不是 linux 那条');
  });
});

describe('resolveEndpoint', () => {
  it('passes the file uuid down to the probe and returns it', async () => {
    const UUID = 'f5011f9f-cd9e-4a7b-a191-3373499fcd6a';
    const seen: Array<string | undefined> = [];
    const probe: typeof probeCdpEndpoint = async (url, _ide, opts) => {
      seen.push(opts?.expect?.browserUuid);
      return { kind: 'ok', cdpUrl: url, port: FILE_PORT, detail: 'ok', at: 1 };
    };
    const result = await resolveEndpoint({
      ide: 'cursor',
      configuredUrl: CONFIG_URL,
      probe,
      readFile: p => (p === FILE_PATH ? `${FILE_PORT}\n/devtools/browser/${UUID}\n` : undefined),
      candidates: [FILE_PATH],
    });
    assert.deepEqual(seen, [UUID], '实例身份要传给探针');
    assert.equal(result.browserUuid, UUID, '也要带出去，CLI status 用的是同一套判据');
    assert.equal(result.source, 'active-port-file');
  });

  it('only claims hasPortFile / uuid when the file port was actually adopted', async () => {
    // File was read but nobody answered that port (eventually falling back to the configured port) → hasPortFile must be false.
    // Else the agent thinks "we can read it back after relaunch" and passes 0 to relaunch → the new port is written into a maybe-unreadable
    // directory → back in the kill loop (review must-fix 2); same for a stale uuid, which would then block the new instance on the configured port.
    const { probe } = recordingProbe(stubProbe('no-listener'));
    const result = await resolveEndpoint({
      ide: 'cursor',
      configuredUrl: CONFIG_URL,
      probe,
      readFile: p => (p === FILE_PATH
        ? `${FILE_PORT}\n/devtools/browser/f5011f9f-cd9e-4a7b-a191-3373499fcd6a\n`
        : undefined),
      candidates: [FILE_PATH],
    });
    assert.equal(result.source, 'config-fallback');
    assert.equal(result.hasPortFile, false, '文件在、但端口没人应答 → 不算读得到');
    assert.equal(result.browserUuid, undefined, '死文件里的旧 uuid 不能带出去');
  });

  it('returns no uuid when the file has no browser line', async () => {
    const result = await resolveEndpoint({
      ide: 'cursor',
      configuredUrl: CONFIG_URL,
      probe: stubProbe('ok'),
      readFile: p => (p === FILE_PATH ? `${FILE_PORT}\n` : undefined),
      candidates: [FILE_PATH],
    });
    assert.equal(result.browserUuid, undefined, '缺一侧就当这一层不存在，不是 mismatch');
  });

  it('skips local files when the configured host is not loopback', async () => {
    let reads = 0;
    let probes = 0;
    const result = await resolveEndpoint({
      ide: 'cursor',
      configuredUrl: 'http://10.0.0.5:9222',
      probe: async (url) => {
        probes += 1;
        return { kind: 'ok', cdpUrl: url, port: 9222, detail: 'ok', at: 1 };
      },
      readFile: () => {
        reads += 1;
        return '52464';
      },
      candidates: [FILE_PATH],
    });
    assert.equal(result.source, 'config');
    assert.equal(result.cdpUrl, 'http://10.0.0.5:9222');
    assert.equal(reads, 0);
    assert.equal(probes, 0);
  });

  it('treats [::1] as loopback (URL.hostname keeps the brackets)', async () => {
    // `new URL('http://[::1]:9222').hostname` is `'[::1]'` (**with brackets**), not `'::1'` —
    // comparing only `'::1'` would call a machine configured with `[::1]` "non-loopback" and silently skip local discovery (review R7).
    let reads = 0;
    const result = await resolveEndpoint({
      ide: 'cursor',
      configuredUrl: 'http://[::1]:9222',
      probe: stubProbe('ok'),
      readFile: (p) => {
        reads += 1;
        return p === FILE_PATH ? `${FILE_PORT}` : undefined;
      },
      candidates: [FILE_PATH],
    });
    assert.ok(reads > 0, 'IPv6 回环也要照常读 DevToolsActivePort');
    assert.equal(result.source, 'active-port-file');
    assert.equal(result.cdpUrl, FILE_URL);
  });

  it('adopts a matching active-port-file (ok / no-window / no-workbench)', async () => {
    const { probe, calls } = recordingProbe(stubProbe('no-window'));
    const result = await resolveEndpoint({
      ide: 'cursor',
      configuredUrl: CONFIG_URL,
      probe,
      readFile: p => (p === FILE_PATH ? `${FILE_PORT}\n/devtools/browser/abc\n` : undefined),
      candidates: [FILE_PATH],
    });
    assert.equal(result.source, 'active-port-file');
    assert.equal(result.cdpUrl, FILE_URL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cdpUrl, FILE_URL);
  });

  it('adopts an unrecognised file port instead of falling back (so the IDE is never killed)', async () => {
    // "Someone answered on the port, but we do not accept them" must never fall back to the configured port:
    // fallback would judge an empty port as no-listener and then relaunch the IDE the user is using (review R3).
    const fetch = fetchMap({
      [`${FILE_URL}/json`]: () => jsonResp(200, []),
      [`${FILE_URL}/json/version`]: () => jsonResp(200, { 'Browser': 'Chrome/148', 'User-Agent': CHROME_UA }),
      // Even if something else sits on the configured port, it must not be probed — this is the regression point.
      [`${CONFIG_URL}/json`]: () => jsonResp(200, [workbench]),
      [`${CONFIG_URL}/json/version`]: () => jsonResp(200, { 'Browser': 'Chrome/148', 'User-Agent': VSCODE_UA }),
    });
    const { probe, calls } = recordingProbe(probeWithFetch(fetch));
    const result = await resolveEndpoint({
      ide: 'cursor',
      configuredUrl: CONFIG_URL,
      probe,
      readFile: p => (p === FILE_PATH ? `${FILE_PORT}\n/devtools/browser/abc\n` : undefined),
      candidates: [FILE_PATH],
    });
    assert.equal(calls.length, 1, '只应探测文件给出的端口，不回退');
    assert.equal(calls[0]?.cdpUrl, FILE_URL);
    assert.equal(calls[0]?.kind, 'not-cdp');
    assert.equal(calls[0]?.notCdpCause, 'foreign');
    assert.equal(result.source, 'active-port-file');
    assert.equal(result.cdpUrl, FILE_URL);
  });

  it('falls back to the configured url when the file cannot be read at all', async () => {
    const { probe, calls } = recordingProbe(stubProbe('unknown'));
    const result = await resolveEndpoint({
      ide: 'cursor',
      configuredUrl: CONFIG_URL,
      probe,
      readFile: () => undefined,
      candidates: [FILE_PATH],
    });
    assert.equal(result.source, 'config-fallback');
    assert.equal(result.cdpUrl, CONFIG_URL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.kind, 'unknown');
  });

  it('reuses a cache entry until no-listener or the file mtime changes', async () => {
    let probes = 0;
    const probe: typeof probeCdpEndpoint = async (url) => {
      probes += 1;
      return { kind: 'ok', cdpUrl: url, port: FILE_PORT, detail: 'ok', at: 1 };
    };
    let mtime = 100;
    const opts = {
      ide: 'cursor' as const,
      configuredUrl: CONFIG_URL,
      probe,
      readFile: (p: string) => (p === FILE_PATH ? `${FILE_PORT}` : undefined),
      candidates: [FILE_PATH],
      mtime: () => mtime,
    };
    const first = await resolveEndpoint(opts);
    const second = await resolveEndpoint(opts);
    assert.equal(first.cdpUrl, FILE_URL);
    assert.equal(second.source, 'active-port-file');
    assert.equal(second.cdpUrl, FILE_URL);
    const probesAfterReuse = probes;

    mtime = 200;
    const third = await resolveEndpoint(opts);
    assert.equal(third.source, 'active-port-file');
    assert.ok(probes > probesAfterReuse);
  });

  it('does not cache a no-listener result', async () => {
    let probes = 0;
    const probe: typeof probeCdpEndpoint = async (url) => {
      probes += 1;
      return { kind: 'no-listener', cdpUrl: url, port: 9222, detail: 'down', at: 1 };
    };
    const opts = {
      ide: 'cursor' as const,
      configuredUrl: CONFIG_URL,
      probe,
      readFile: () => undefined,
      candidates: [FILE_PATH],
    };
    await resolveEndpoint(opts);
    await resolveEndpoint(opts);
    assert.equal(probes, 2);
  });

  it('does not keep a cached file port after it becomes no-listener with the same mtime', async () => {
    const kinds = new Map<string, ProbeResult['kind']>([
      [FILE_URL, 'ok'],
      [CONFIG_URL, 'ok'],
    ]);
    const probe: typeof probeCdpEndpoint = async (url) => {
      const kind = kinds.get(url) ?? 'no-listener';
      return { kind, cdpUrl: url, port: 1, detail: kind, at: 1 };
    };
    const opts = {
      ide: 'cursor' as const,
      configuredUrl: CONFIG_URL,
      probe,
      readFile: (p: string) => (p === FILE_PATH ? `${FILE_PORT}` : undefined),
      candidates: [FILE_PATH],
      mtime: () => 100,
    };

    const first = await resolveEndpoint(opts);
    assert.equal(first.cdpUrl, FILE_URL);
    assert.equal(first.source, 'active-port-file');

    kinds.set(FILE_URL, 'no-listener');
    const second = await resolveEndpoint(opts);
    assert.equal(second.cdpUrl, CONFIG_URL);
    assert.equal(second.source, 'config-fallback');
  });

  it('clearEndpointCache(ide) drops that ide so a same-mtime file rewrite is picked up', async () => {
    let port = FILE_PORT;
    const probe: typeof probeCdpEndpoint = async url => ({
      kind: 'ok',
      cdpUrl: url,
      port: 1,
      detail: 'ok',
      at: 1,
    });
    const opts = {
      ide: 'cursor' as const,
      configuredUrl: CONFIG_URL,
      probe,
      readFile: (p: string) => (p === FILE_PATH ? `${port}` : undefined),
      candidates: [FILE_PATH],
      mtime: () => 100,
    };
    const first = await resolveEndpoint(opts);
    assert.equal(first.cdpUrl, FILE_URL);

    port = 9333;
    const pinned = await resolveEndpoint(opts);
    assert.equal(pinned.cdpUrl, FILE_URL);

    clearEndpointCache('cursor');
    const rediscovered = await resolveEndpoint(opts);
    assert.equal(rediscovered.cdpUrl, 'http://127.0.0.1:9333');
    assert.equal(rediscovered.source, 'active-port-file');
  });
});

describe('CDPBridge.setCdpUrl', () => {
  it('updates the url subsequent connect/probe/fetch use', () => {
    const config: AgentConfig = {
      cdpUrl: CONFIG_URL,
      codebuddyCdpUrl: 'http://127.0.0.1:9223',
      pollIntervalMs: 300,
      debounceMs: 10,
      selectorsPath: './selectors.json',
      logLevel: 'error',
      windowTitleQualifier: true,
      dataDir: '/tmp',
      remoteUrl: '',
      agentsWindow: true,
      agentToken: '',
    };
    const bridge = new CDPBridge(config);
    bridge.setCdpUrl(FILE_URL, { source: 'active-port-file' });
    assert.equal(bridge.cdpUrl, FILE_URL);
    assert.equal(config.cdpUrl, FILE_URL);
  });
});
