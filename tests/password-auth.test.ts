import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import {
  buildSessionCookie,
  parseSessionCookie,
} from '../packages/server/src/auth/password.js';
import { Relay } from '../packages/server/src/relay.js';

const PRESET = 'preset-password-42';

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

function passwordConfig(
  port: number,
  dataDir: string,
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  return {
    serverPort: port,
    serverHost: '127.0.0.1',
    dataDir,
    logLevel: 'error',
    authProviderName: 'password',
    authPassword: PRESET,
    ...overrides,
  };
}

async function startRelay(cfg: ServerConfig): Promise<Relay> {
  const relay = new Relay(cfg);
  await relay.start();
  return relay;
}

function postJson(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function login(port: number, password: string): Promise<Response> {
  return postJson(port, '/api/login', { password });
}

async function sessionCookie(port: number): Promise<string> {
  const res = await login(port, PRESET);
  assert.equal(res.status, 200, 'preset login should succeed');
  const raw = res.headers.get('set-cookie') ?? '';
  const cookie = /lifeline_session=[^;]+/.exec(raw)?.[0];
  assert.ok(cookie, `no session cookie in "${raw}"`);
  return cookie;
}

function waitForUserInfo(
  socket: ReturnType<typeof ioClient>,
): Promise<{ userId: string; authKind?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('user:info never arrived')), 5000);
    socket.on('user:info', (data: { userId: string; authKind?: string }) => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectError(socket: ReturnType<typeof ioClient>): Promise<Error> {
  return new Promise((resolve) => {
    socket.on('connect_error', (err: Error) => resolve(err));
  });
}

describe('session cookie primitives', () => {
  it('round-trips and rejects tampering, wrong secret, expiry, and garbage', () => {
    const secret = 's'.repeat(64);
    const now = Date.now();
    const cookie = buildSessionCookie('owner', now + 60_000, secret);
    assert.equal(parseSessionCookie(cookie, secret, now), 'owner');
    assert.equal(parseSessionCookie(cookie, secret, now + 61_000), null); // expired
    assert.equal(parseSessionCookie(cookie.replace('owner', 'admin'), secret, now), null); // tampered userId
    assert.equal(parseSessionCookie(cookie, 'x'.repeat(64), now), null); // wrong secret
    assert.equal(parseSessionCookie('garbage', secret, now), null);
    assert.equal(parseSessionCookie('v1||123|x'.repeat(64), secret, now), null);
  });
});

describe('password provider claim bootstrap (no preset)', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;
  let claimCode: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-claim-'));
    port = await getFreePort();
    // Capture stdout: the claim code only appears here (no API should expose it)
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      relay = await startRelay(passwordConfig(port, dir, { authPassword: undefined }));
    }
    finally {
      console.log = origLog;
    }
    claimCode = /([0-9a-f]{64})/.exec(logs.join('\n'))?.[1] ?? '';
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints a 32-byte-hex one-time code and serves /claim publicly', async () => {
    assert.match(claimCode, /^[0-9a-f]{64}$/);
    const page = await fetch(`http://127.0.0.1:${port}/claim`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /设置密码/);
  });

  it('rejects a bad code and a short password without burning the real code, then accepts it once', async () => {
    const bad = await postJson(port, '/api/claim', { code: 'nope', password: 'longenough1' });
    assert.equal(bad.status, 400);

    // Short password is rejected before redeeming → a good code is not burned
    const short = await postJson(port, '/api/claim', { code: claimCode, password: 'short' });
    assert.equal(short.status, 400);

    const ok = await postJson(port, '/api/claim', { code: claimCode, password: 'longenough1' });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /lifeline_session=v1\|owner\|\d+\|[0-9a-f]{64}/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//);

    // One-shot redeem: replaying the same code → 400
    const replay = await postJson(port, '/api/claim', { code: claimCode, password: 'longenough1' });
    assert.equal(replay.status, 400);
  });

  it('unauthenticated page GET redirects to /claim; APIs and assets get 403', async () => {
    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/claim?next=%2F');

    const api = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(api.status, 403);
  });

  it('keeps the original URL in the redirect (CLI setup flow survives login)', async () => {
    // `/cli-setup?redirect_uri=...` opened by `lifeline setup` always happens while logged out:
    // a 302 that drops params makes the local callback wait the full 3 minutes — next must come back intact.
    const target = '/cli-setup?redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback';
    const res = await fetch(`http://127.0.0.1:${port}${target}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location') ?? '';
    assert.ok(location.startsWith('/claim?next='), location);
    const next = decodeURIComponent(location.slice('/claim?next='.length));
    assert.equal(next, target);
  });

  it('after claiming, page GET redirects to /login and the cookie opens the API', async () => {
    const ok = await postJson(port, '/api/claim', { code: claimCode, password: 'longenough1' });
    assert.equal(ok.status, 200);
    const cookie = /lifeline_session=[^;]+/.exec(ok.headers.get('set-cookie') ?? '')?.[0] ?? '';

    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(root.headers.get('location'), '/login?next=%2F');

    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Cookie: cookie } });
    assert.equal(health.status, 200);
  });
});

describe('password provider login and rate limit (preset)', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-login-'));
    port = await getFreePort();
    relay = await startRelay(passwordConfig(port, dir));
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('preset password: no claim code printed, /login served, wrong password 401', async () => {
    const loginPage = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /登录/);

    const wrong = await login(port, 'wrong-password');
    assert.equal(wrong.status, 401);
  });

  it('five failures lock the IP for the window (even the correct password is 429)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(port, 'wrong-password');
      assert.equal(res.status, 401);
    }
    const limitedWrong = await login(port, 'wrong-password');
    assert.equal(limitedWrong.status, 429);
    const limitedRight = await login(port, PRESET);
    assert.equal(limitedRight.status, 429);
  });

  it('correct password sets a cookie that opens gated HTTP and sockets', async () => {
    const cookie = await sessionCookie(port);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Cookie: cookie } });
    assert.equal(health.status, 200);

    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Cookie: cookie },
      reconnection: false,
    });
    try {
      const info = await waitForUserInfo(socket);
      assert.equal(info.userId, 'owner');
      assert.equal(info.authKind, 'password');
    }
    finally {
      socket.close();
    }
  });

  it('marks the cookie Secure when the proxy declares https', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ password: PRESET }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /Secure/);
  });
});

describe('password provider Secure flag via PUBLIC_ORIGIN', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-secure-'));
    port = await getFreePort();
    relay = await startRelay(
      passwordConfig(port, dir, { publicOrigin: 'https://lifeline.example.com' }),
    );
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('PUBLIC_ORIGIN=https alone is enough for the Secure flag (no XFP needed)', async () => {
    const res = await login(port, PRESET);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /Secure/);
  });
});

describe('password provider WS origin checks', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-ws-'));
    port = await getFreePort();
    relay = await startRelay(passwordConfig(port, dir));
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a cross-origin handshake even with a valid cookie', async () => {
    const cookie = await sessionCookie(port);
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Cookie: cookie, Origin: 'https://evil.example' },
      reconnection: false,
    });
    try {
      const err = await connectError(socket);
      assert.match(err.message, /Origin/);
    }
    finally {
      socket.close();
    }
  });

  it('accepts a matching Origin derived from the Host header', async () => {
    const cookie = await sessionCookie(port);
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
      reconnection: false,
    });
    try {
      const info = await waitForUserInfo(socket);
      assert.equal(info.userId, 'owner');
    }
    finally {
      socket.close();
    }
  });

  it('honors X-Forwarded-Host + Proto as the expected origin (reverse proxy)', async () => {
    const cookie = await sessionCookie(port);
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: {
        'Cookie': cookie,
        'Origin': 'https://example.com',
        'X-Forwarded-Host': 'example.com',
        'X-Forwarded-Proto': 'https',
      },
      reconnection: false,
    });
    try {
      const info = await waitForUserInfo(socket);
      assert.equal(info.userId, 'owner');
    }
    finally {
      socket.close();
    }

    // Same forwarded headers + forged Origin → reject
    const bad = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: {
        'Cookie': cookie,
        'Origin': 'https://evil.example',
        'X-Forwarded-Host': 'example.com',
        'X-Forwarded-Proto': 'https',
      },
      reconnection: false,
    });
    try {
      const err = await connectError(bad);
      assert.match(err.message, /Origin/);
    }
    finally {
      bad.close();
    }
  });

  it('lets non-browser clients through without an Origin header', async () => {
    const cookie = await sessionCookie(port);
    // node's socket.io-client sends no Origin by default — CLI / non-browser shape
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Cookie: cookie },
      reconnection: false,
    });
    try {
      const info = await waitForUserInfo(socket);
      assert.equal(info.userId, 'owner');
    }
    finally {
      socket.close();
    }
  });

  it('without a cookie the handshake is Unauthorized regardless of Origin', async () => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Origin: `http://127.0.0.1:${port}` },
      reconnection: false,
    });
    try {
      const err = await connectError(socket);
      assert.match(err.message, /Unauthorized/);
    }
    finally {
      socket.close();
    }
  });
});
