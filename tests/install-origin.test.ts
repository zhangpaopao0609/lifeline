import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isSafeInstallerHost, Relay } from '../packages/server/src/relay.js';

/** undici's fetch will not override Host (it sends the URL host); injection cases must use raw http. */
function fetchWithHost(port: number, path: string, host: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

/** loopback + no config = none provider — the minimal self-host form. */
function noneConfig(port: number, dataDir: string): ServerConfig {
  return {
    serverPort: port,
    serverHost: '127.0.0.1',
    dataDir,
    logLevel: 'error',
  };
}

describe('install scripts origin rewriting', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'install-origin-'));
    port = await getFreePort();
    relay = new Relay(noneConfig(port, dir));
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites __SERVER_ORIGIN__ in install.sh to the request origin', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/public/install.sh`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes(`http://127.0.0.1:${port}`), 'script should point at this origin');
    assert.ok(!text.includes('__SERVER_ORIGIN__'), 'placeholder must be rewritten');
  });

  it('rewrites install.ps1 the same way', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/public/install.ps1`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes(`http://127.0.0.1:${port}`));
    assert.ok(!text.includes('__SERVER_ORIGIN__'));
  });

  it('keeps the un-rewritten-copy guard intact (global replace must not trip it)', async () => {
    // Regression: trySendInstaller is a global replace. If the guard comparison string is
    // written as the whole placeholder, it gets rewritten to the real origin too, so
    // "BASE == real origin" is always true — normally distributed scripts all trip their
    // own guard (production curl | sh reports "not rewritten by origin"). So both scripts
    // split the guard into two literals; this asserts the split form still exists in the
    // rewritten response.
    const shText = await (await fetch(`http://127.0.0.1:${port}/public/install.sh`)).text();
    assert.ok(
      shText.includes('"__SERVER_ORIGIN""__"'),
      'install.sh guard literal must survive the rewrite',
    );
    const ps1Text = await (await fetch(`http://127.0.0.1:${port}/public/install.ps1`)).text();
    assert.ok(
      ps1Text.includes('(\'__SERVER_ORIGIN\' + \'__\')'),
      'install.ps1 guard literal must survive the rewrite',
    );
  });

  it('honors x-forwarded-proto when deriving the origin (TLS terminator)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/public/install.sh`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const text = await res.text();
    assert.ok(text.includes(`https://127.0.0.1:${port}`), 'https origin behind a proxy');
    assert.ok(!text.includes(`http://127.0.0.1:${port}`), 'should not stay http');
  });

  it('serves uninstall.sh untouched (no rewrite for non-installers)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/public/uninstall.sh`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(`http://127.0.0.1:${port}`), 'uninstall.sh is served verbatim');
  });

  it('refuses to rewrite a hostile Host header (shell/PS injection attempt)', async () => {
    // The Host header admits quotes/backticks/$() (Node only rejects CR/LF), and the
    // rewrite lands directly in `BASE="http://<host>"` (sh double quotes) and
    // `$base='...'` (PS single quotes) — a suspicious Host is never rewritten, so the
    // placeholder goes out as-is (the script's own guard then exits).
    for (const hostile of [
      'evil.com$(id)',
      'evil.com`id`',
      'evil.com\';rm -rf /;\'',
      'evil.com;curl attacker',
      'evil.com\\nBASH_ENV=x',
    ]) {
      const res = await fetchWithHost(port, '/public/install.sh', hostile);
      assert.equal(res.status, 200, hostile);
      assert.ok(res.text.includes('__SERVER_ORIGIN__'), `placeholder must stay for "${hostile}"`);
      assert.ok(!res.text.includes(hostile), `hostile host must not reach the script: "${hostile}"`);
    }
  });
});

describe('isSafeInstallerHost', () => {
  it('accepts hostnames, IPv4, bracketed IPv6 and ports', () => {
    for (const ok of [
      'lifeline.example.com',
      '127.0.0.1',
      'example.com:8080',
      '[::1]:3000',
      'sub.domain-x.io',
    ]) {
      assert.ok(isSafeInstallerHost(ok), ok);
    }
  });

  it('rejects shell/PowerShell metacharacters and control junk', () => {
    for (const bad of [
      'evil.com$(id)',
      'evil.com`id`',
      'a\'b',
      'a"b',
      'a;b',
      'a b',
      'a\nb',
      'a\\b',
      'javascript:alert(1)',
    ]) {
      assert.ok(!isSafeInstallerHost(bad), bad);
    }
  });
});
