import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { io as ioClient } from 'socket.io-client';
import { scryptCallCount, verifyPasswordHash } from '../packages/server/src/auth/accounts.js';
import { rateLimitKey } from '../packages/server/src/auth/client-address.js';
import { loginPage, safeNext } from '../packages/server/src/auth/password-pages.js';
import {
  buildSessionCookie,
  parseSessionCookie,
  publicOriginIsHttps,
} from '../packages/server/src/auth/password.js';
import { Relay } from '../packages/server/src/relay.js';

const PASSWORD = 'correct-horse-1';

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
    ...overrides,
  };
}

async function startRelay(cfg: ServerConfig): Promise<Relay> {
  const relay = new Relay(cfg);
  await relay.start();
  return relay;
}

function origin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': origin(port),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function register(port: number, username: string, password = PASSWORD, confirm = password): Promise<Response> {
  return postJson(port, '/api/register', { username, password, passwordConfirm: confirm });
}

function login(port: number, username: string, password = PASSWORD): Promise<Response> {
  return postJson(port, '/api/login', { username, password });
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const cookie = /lifeline_session=[^;]+/.exec(raw)?.[0];
  assert.ok(cookie, `no session cookie in "${raw}"`);
  return cookie;
}

interface HealthBody {
  machines: Array<{ agentId: string }>;
  agentConnected: boolean;
}

async function waitForMachines(
  port: number,
  cookie: string,
  ready: (ids: string[]) => boolean,
): Promise<HealthBody> {
  const start = Date.now();
  let last: HealthBody = { machines: [], agentConnected: false };
  while (Date.now() - start < 5000) {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Cookie: cookie } });
    last = await res.json() as HealthBody;
    if (ready(last.machines.map(machine => machine.agentId)))
      return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`machines never matched: ${JSON.stringify(last.machines)}`);
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
    const cookie = buildSessionCookie('alice', now + 60_000, secret);
    assert.equal(parseSessionCookie(cookie, secret, now), 'alice');
    assert.equal(parseSessionCookie(cookie, secret, now + 61_000), null);
    assert.equal(parseSessionCookie(cookie.replace('alice', 'admin'), secret, now), null);
    assert.equal(parseSessionCookie(cookie, 'x'.repeat(64), now), null);
    assert.equal(parseSessionCookie('garbage', secret, now), null);
    assert.equal(parseSessionCookie('v1||123|x'.repeat(64), secret, now), null);
  });
});

describe('next target', () => {
  it('keeps a same-origin path and rejects off-site or odd targets', () => {
    assert.equal(safeNext('/cli-setup?redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback'), '/cli-setup?redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback');
    assert.equal(safeNext('//evil.example'), '/');
    assert.equal(safeNext('/\\evil.example'), '/');
    assert.equal(safeNext('/has space'), '/');
    assert.equal(safeNext('/has\nline'), '/');
    assert.equal(safeNext('https://evil.example'), '/');
    assert.equal(safeNext('/\u0085evil'), '/');
    assert.equal(safeNext('/\u009F'), '/');
    assert.ok(loginPage('nonce', true).includes(safeNext.toString()));
  });
});

describe('password hash parameters', () => {
  it('does not run scrypt when N is larger than the one we write', async () => {
    const before = scryptCallCount();
    const ok = await verifyPasswordHash(
      'correct-horse-1',
      `scrypt$999999$8$1$${'ab'.repeat(16)}$${'cd'.repeat(32)}`,
    );
    assert.equal(ok, false);
    assert.equal(scryptCallCount(), before);
  });
});

describe('rate-limit key', () => {
  it('ignores forwarded headers from a public peer', () => {
    assert.equal(
      rateLimitKey('8.8.8.8', { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }, true),
      '8.8.8.8',
    );
  });

  it('uses a single X-Real-IP only from a private peer when the proxy flag is on', () => {
    assert.equal(rateLimitKey('172.17.0.1', { 'x-real-ip': '9.9.9.9' }, true), '9.9.9.9');
    assert.equal(rateLimitKey('127.0.0.1', { 'x-real-ip': '9.9.9.9' }, false), '127.0.0.1');
    assert.equal(rateLimitKey('127.0.0.1', { 'x-real-ip': '1.2.3.4, 5.6.7.8' }, true), '127.0.0.1');
    assert.equal(rateLimitKey('::ffff:172.17.0.1', { 'x-real-ip': '9.9.9.9' }, true), '9.9.9.9');
    assert.equal(rateLimitKey('172.17.0.1', { 'x-real-ip': '::ffff:1.2.3.4' }, true), '1.2.3.4');
    assert.equal(rateLimitKey('100.64.0.1', { 'x-real-ip': '9.9.9.9' }, true), '100.64.0.1');
  });

  it('treats an uppercase https scheme as https', () => {
    assert.equal(publicOriginIsHttps('HTTPS://lifeline.example.com'), true);
    assert.equal(publicOriginIsHttps('http://lifeline.example.com'), false);
  });
});

describe('password accounts', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-accounts-'));
    port = await getFreePort();
    relay = await startRelay(passwordConfig(port, dir));
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers a canonical username and only that user can enroll a machine', async () => {
    const created = await register(port, 'Alice');
    assert.equal(created.status, 200);
    const setCookie = created.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /lifeline_session=v1\|alice\|\d+\|[0-9a-f]{64}/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = cookieOf(created);

    const setup = await fetch(
      `http://127.0.0.1:${port}/cli-setup?redirect_uri=${encodeURIComponent('http://127.0.0.1:9/callback')}`,
      { headers: { Cookie: cookie }, redirect: 'manual' },
    );
    assert.equal(setup.status, 302);
    const code = new URL(setup.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    const exchanged = await postJson(port, '/public/cli-setup/exchange', { code, agentId: 'agent-alice' });
    assert.equal(exchanged.status, 200);

    const db = new Database(join(dir, 'lifeline.sqlite'));
    const row = db.prepare('SELECT owner_user_id FROM machine_tokens WHERE agent_id = ?').get('agent-alice') as { owner_user_id: string };
    db.close();
    assert.equal(row.owner_user_id, 'alice');

    const token = ((await exchanged.json()) as { agentToken: string }).agentToken;
    const agent = ioClient(`http://127.0.0.1:${port}/agent`, {
      path: '/agent-io',
      auth: { agentToken: token },
      transports: ['websocket'],
      reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('agent did not connect')), 5000);
        agent.on('connect', () => {
          agent.emit('agent:register', { agentId: 'agent-alice', hostname: 'Alice-MBP', version: '9.9.9' });
          clearTimeout(timer);
          resolve();
        });
        agent.on('connect_error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const aliceHealth = await waitForMachines(port, cookie, ids => ids.includes('agent-alice'));
      assert.deepEqual(aliceHealth.machines.map(machine => machine.agentId), ['agent-alice']);

      const bob = cookieOf(await register(port, 'bob'));
      const bobHealth = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Cookie: bob } });
      const bobBody = await bobHealth.json() as HealthBody;
      assert.deepEqual(bobBody.machines, []);
      assert.equal(bobBody.agentConnected, false);
    }
    finally {
      agent.close();
    }
  });

  it('rejects illegal usernames without echoing them', async () => {
    for (const username of ['ab', '全角名', 'Ａlice', 'has space', '\u212Aelvinname']) {
      const res = await register(port, username);
      assert.equal(res.status, 400, username);
      const body = await res.json() as { error: string };
      assert.equal(body.error.includes(username), false);
    }
  });

  it('rejects a weak password and a taken name', async () => {
    assert.equal((await register(port, 'alice', 'short')).status, 400);
    assert.equal((await register(port, 'alice', PASSWORD, 'different-pass')).status, 400);
    assert.equal((await register(port, 'longnamehere', 'longnamehere')).status, 400);
    assert.equal((await register(port, 'Alice')).status, 200);
    const again = await register(port, 'alice');
    assert.equal(again.status, 409);
    const body = await again.json() as { error: string };
    assert.equal(body.error.includes('SQLITE'), false);
  });

  it('does not run scrypt for a password longer than 128 characters', async () => {
    const before = scryptCallCount();
    const res = await register(port, 'alice', 'x'.repeat(129));
    assert.equal(res.status, 400);
    assert.equal(scryptCallCount(), before);
    const loggingIn = await login(port, 'alice', 'y'.repeat(129));
    assert.equal(loggingIn.status, 400);
    assert.equal(scryptCallCount(), before);
  });

  it('login failure looks the same when the user is missing or the password is wrong', async () => {
    await register(port, 'alice');
    const before = scryptCallCount();
    const missing = await login(port, 'nobody');
    const afterMissing = scryptCallCount();
    const wrong = await login(port, 'alice', 'wrong-password-xx');
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(await missing.json(), await wrong.json());
    assert.equal(afterMissing - before, 1, 'a missing user still pays one dummy scrypt');
    assert.equal(scryptCallCount() - afterMissing, 1);
  });

  it('five failures lock the address, including a later correct password', async () => {
    await register(port, 'alice');
    for (let i = 0; i < 5; i++)
      assert.equal((await login(port, 'alice', 'wrong-password-xx')).status, 401);
    assert.equal((await login(port, 'alice', 'wrong-password-xx')).status, 429);
    assert.equal((await login(port, 'alice')).status, 429);
  });

  it('a burst of wrong passwords cannot slip past the five-failure cap', async () => {
    await register(port, 'alice');
    const before = scryptCallCount();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => login(port, 'alice', 'wrong-password-xx')),
    );
    const denied = results.filter(res => res.status === 401).length;
    const limited = results.filter(res => res.status === 429).length;
    assert.equal(denied, 5);
    assert.equal(limited, 7);
    assert.equal(scryptCallCount() - before, 5);
  });

  it('a burst cannot create more than three accounts', async () => {
    const names = ['a01', 'a02', 'a03', 'a04', 'a05', 'a06'];
    const results = await Promise.all(names.map(name => register(port, name)));
    assert.equal(results.filter(res => res.status === 200).length, 3);
    assert.equal(results.filter(res => res.status === 429).length, 3);
    const db = new Database(join(dir, 'lifeline.sqlite'));
    const row = db.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get() as { n: number };
    db.close();
    assert.equal(row.n, 3);
  });

  it('two simultaneous registers of one name yield one account and no SQL error', async () => {
    const [left, right] = await Promise.all([register(port, 'alice'), register(port, 'alice')]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);
    const bodies = [JSON.stringify(await left.json()), JSON.stringify(await right.json())];
    assert.equal(bodies.some(body => body.includes('SQLITE')), false);
  });

  it('does not record the submitted password in the failure log', async () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await login(port, 'alice', 'unique-secret-pass');
    }
    finally {
      console.warn = orig;
    }
    assert.equal(lines.some(line => line.includes('unique-secret-pass')), false);
    assert.equal(lines.some(line => line.includes('/api/login') && line.includes('401')), true);
  });

  it('rejects login and register without Origin or JSON', async () => {
    const noOrigin = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.headers.get('set-cookie'), null);

    const cross = await postJson(port, '/api/register', {
      username: 'alice',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    }, { Origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    assert.equal(cross.headers.get('set-cookie'), null);

    const text = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Origin': origin(port) },
      body: 'username=alice',
    });
    assert.equal(text.status, 415);
    assert.equal(text.headers.get('set-cookie'), null);
  });

  it('sends the login page with a locked-down policy and redirects logged-out pages to it', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /登录/);
    assert.match(html, /注册账号/);
    assert.match(html, /textContent/);
    assert.equal(html.includes('innerHTML'), false);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'nonce-/);

    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.notEqual(root.status, 302);
    assert.equal(root.headers.get('location'), null);
    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`, { redirect: 'manual' });
    assert.notEqual(asset.status, 302);
    assert.notEqual(asset.status, 403);
    const consolePage = await fetch(`http://127.0.0.1:${port}/console`, { redirect: 'manual' });
    assert.equal(consolePage.status, 302);
    assert.equal(consolePage.headers.get('location'), '/login?next=%2Fconsole');
    const target = '/cli-setup?redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback';
    const bounced = await fetch(`http://127.0.0.1:${port}${target}`, { redirect: 'manual' });
    const location = bounced.headers.get('location') ?? '';
    assert.equal(decodeURIComponent(location.slice('/login?next='.length)), target);
  });

  it('sends an already logged-in browser from login and register back to the console', async () => {
    const cookie = cookieOf(await register(port, 'alice'));
    const loggingIn = await fetch(`http://127.0.0.1:${port}/login`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(loggingIn.status, 302);
    assert.equal(loggingIn.headers.get('location'), '/');
    const signingUp = await fetch(`http://127.0.0.1:${port}/register`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(signingUp.status, 302);
    assert.equal(signingUp.headers.get('location'), '/');
  });

  it('opens HTTP and the socket for the registered user', async () => {
    const cookie = cookieOf(await register(port, 'alice'));
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Cookie: cookie } });
    assert.equal(health.status, 200);
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Cookie: cookie },
      reconnection: false,
    });
    try {
      const info = await waitForUserInfo(socket);
      assert.equal(info.userId, 'alice');
      assert.equal(info.authKind, 'password');
    }
    finally {
      socket.close();
    }
  });

  it('rejects a signed cookie after the account row is gone', async () => {
    const cookie = cookieOf(await register(port, 'alice'));
    const db = new Database(join(dir, 'lifeline.sqlite'));
    db.prepare('DELETE FROM auth_accounts WHERE user_id = ?').run('alice');
    db.close();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Cookie: cookie } });
    assert.equal(health.status, 403);
  });

  it('marks the cookie Secure when the proxy declares https', async () => {
    await register(port, 'alice');
    const res = await postJson(port, '/api/login', { username: 'alice', password: PASSWORD }, {
      'Origin': `https://127.0.0.1:${port}`,
      'X-Forwarded-Proto': 'https',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /Secure/);
  });
});

describe('registration closed', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-closed-'));
    port = await getFreePort();
    relay = await startRelay(passwordConfig(port, dir));
    assert.equal((await register(port, 'alice')).status, 200);
    await relay.stop();
    relay = await startRelay(passwordConfig(port, dir, { authRegistrationOpen: false }));
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses new accounts without saying whether the name exists, and still logs the old one in', async () => {
    const probe = 'not-a-real-name';
    const res = await register(port, probe);
    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.equal(body.error.includes(probe), false);
    const page = await fetch(`http://127.0.0.1:${port}/register`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
    const loginPage = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal((await loginPage.text()).includes('注册账号'), false);
    assert.equal((await login(port, 'alice')).status, 200);
  });
});

describe('password provider Secure flag via PUBLIC_ORIGIN', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-secure-'));
    port = await getFreePort();
    relay = await startRelay(passwordConfig(port, dir, { publicOrigin: 'https://lifeline.example.com' }));
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('PUBLIC_ORIGIN=https alone is enough for the Secure flag', async () => {
    const res = await postJson(port, '/api/register', {
      username: 'alice',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    }, { Origin: 'https://lifeline.example.com' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /Secure/);
  });
});

describe('uppercase PUBLIC_ORIGIN', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-https-case-'));
    port = await getFreePort();
    relay = await startRelay(passwordConfig(port, dir, { publicOrigin: 'HTTPS://lifeline.example.com' }));
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a lowercase browser Origin and still marks the cookie Secure', async () => {
    const res = await postJson(port, '/api/register', {
      username: 'alice',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    }, { Origin: 'https://lifeline.example.com' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /Secure/);
  });
});

describe('password provider WS origin checks', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;
  let cookie: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-ws-'));
    port = await getFreePort();
    relay = await startRelay(passwordConfig(port, dir));
    cookie = cookieOf(await register(port, 'alice'));
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a cross-origin handshake even with a valid cookie', async () => {
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
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Cookie: cookie, Origin: origin(port) },
      reconnection: false,
    });
    try {
      const info = await waitForUserInfo(socket);
      assert.equal(info.userId, 'alice');
    }
    finally {
      socket.close();
    }
  });

  it('lets non-browser clients through without an Origin header', async () => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Cookie: cookie },
      reconnection: false,
    });
    try {
      const info = await waitForUserInfo(socket);
      assert.equal(info.userId, 'alice');
    }
    finally {
      socket.close();
    }
  });
});

describe('registration attempt cap', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;
  let clock: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-hourly-'));
    port = await getFreePort();
    clock = 1_000_000;
    relay = await startRelay(passwordConfig(port, dir, { now: () => clock }));
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops at 30 registration attempts per hour after the per-minute failures reset', async () => {
    for (let minute = 0; minute < 6; minute++) {
      for (let n = 0; n < 5; n++)
        assert.equal((await register(port, 'bad name')).status, 400);
      clock += 60_000;
    }
    const before = scryptCallCount();
    const blocked = await register(port, 'alice');
    assert.equal(blocked.status, 429);
    assert.equal(scryptCallCount(), before);
    const db = new Database(join(dir, 'lifeline.sqlite'));
    const row = db.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get() as { n: number };
    db.close();
    assert.equal(row.n, 0);
  });
});

describe('gateway auth does not mount account registration', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-header-'));
    port = await getFreePort();
    relay = await startRelay({
      serverPort: port,
      serverHost: '127.0.0.1',
      dataDir: dir,
      logLevel: 'error',
      authHeaderName: 'x-test-user',
    });
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves neither the register page nor a register API', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/register`, {
      headers: { 'x-test-user': 'alice' },
    });
    const html = await page.text();
    assert.equal(html.includes('注册并进入'), false);

    const anonymous = await postJson(port, '/api/register', {
      username: 'alice',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    });
    assert.equal(anonymous.status, 403);
    assert.equal(anonymous.headers.get('set-cookie'), null);

    const authed = await postJson(port, '/api/register', {
      username: 'alice',
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    }, { 'x-test-user': 'alice' });
    assert.equal(authed.status, 404);
    assert.equal(authed.headers.get('set-cookie'), null);
  });
});
