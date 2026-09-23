import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { Relay } from '../packages/server/src/relay.js';
import { TEST_AUTH_HEADER, TEST_OWNER, userHeaders } from './relay-auth-helpers.js';

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

function serverConfig(
  port: number,
  dataDir: string,
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  return {
    serverPort: port,
    serverHost: '127.0.0.1',
    logLevel: 'error',
    // AUTH_HEADER + loopback = trusted-header: a present header is identity (cheapest real auth).
    authHeaderName: TEST_AUTH_HEADER,
    dataDir,
    ...overrides,
  };
}

describe('relay HTTP auth', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-auth-'));
    port = await getFreePort();
    relay = new Relay(serverConfig(port, dir));
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('no auth config on loopback boots the none provider', async () => {
    // No AUTH config + loopback = none single-user mode (public / all-interface bind is never allowed).
    const port2 = await getFreePort();
    const cfg = serverConfig(port2, dir, { authHeaderName: undefined });
    const relay2 = new Relay(cfg);
    await relay2.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/api/health`);
      assert.equal(res.status, 200);
    }
    finally {
      await relay2.stop();
    }
  });

  it('/healthz is public; /api/health and / require identity', async () => {
    const z = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(z.status, 200);
    assert.deepEqual(await z.json(), { ok: true });

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 403);

    // The console lives in the frontend router (/console), but it is still a gated screen:
    // falling back to index.html must happen after the gate, so SPA fallback does not make it public.
    const console_ = await fetch(`http://127.0.0.1:${port}/console`);
    assert.equal(console_.status, 403);

    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 403);
    assert.match(root.headers.get('content-type') || '', /text\/html/);
    const html = await root.text();
    assert.match(html, /Sign-in required/);
    assert.match(html, /LIFE/);
    assert.doesNotMatch(html, /Forbidden/);
  });

  it('valid identity can load /api/health', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: userHeaders(TEST_OWNER),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agentConnected: boolean };
    assert.equal(body.agentConnected, false);
  });

  it('GET /cli-setup without identity is 403; with identity redirects to callback', async () => {
    const redirect = 'http://127.0.0.1:9/callback';
    const url = `http://127.0.0.1:${port}/cli-setup?redirect_uri=${encodeURIComponent(redirect)}`;
    const denied = await fetch(url, { redirect: 'manual' });
    assert.equal(denied.status, 403);

    const ok = await fetch(url, { headers: userHeaders(TEST_OWNER), redirect: 'manual' });
    assert.equal(ok.status, 302);
    const loc = ok.headers.get('location') ?? '';
    assert.match(loc, /^http:\/\/127\.0\.0\.1:9\/callback\?code=/);
  });

  it('POST /public/cli-setup/exchange stays public (invalid code still 400)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/public/cli-setup/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'nope', agentId: 'machine-x' }),
    });
    assert.equal(res.status, 400);
  });

  it('/public/* is public (404 for a missing asset, not 403); ../ cannot borrow the prefix', async () => {
    // packages/web/public in the repo is the unauthenticated dir for tests; install.sh must be reachable.
    const install = await fetch(`http://127.0.0.1:${port}/public/install.sh`);
    assert.equal(install.status, 200);

    const missing = await fetch(`http://127.0.0.1:${port}/public/nope.txt`);
    assert.equal(missing.status, 404);

    // %2e%2e is not normalised by fetch, so it hits the server as-is; after normalisation it is
    // /index.html and must still require identity.
    const escape = await fetch(`http://127.0.0.1:${port}/public/%2e%2e/index.html`);
    assert.equal(escape.status, 403);

    // All old root-path openings are closed
    const rootInstall = await fetch(`http://127.0.0.1:${port}/install.sh`);
    assert.equal(rootInstall.status, 403);
  });

  it('GET /login is gone', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal(res.status, 403);
  });
});

describe('relay socket identity', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-socket-'));
    port = await getFreePort();
    relay = new Relay(
      serverConfig(port, dir, { authAvatarUrl: 'https://cdn.example.com/avatars/{userId}.png' }),
    );
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits user:info with the userId, authKind and the server-resolved avatar', async () => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: userHeaders(TEST_OWNER),
      reconnection: false,
    });

    try {
      const payload = await new Promise<{ userId: string; avatar: string; authKind: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('user:info never arrived')), 5000);
          socket.on('user:info', (data: { userId: string; avatar: string; authKind: string }) => {
            clearTimeout(timer);
            resolve(data);
          });
          socket.on('connect_error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        },
      );

      assert.equal(payload.userId, TEST_OWNER);
      assert.equal(payload.authKind, 'trusted-header');
      // Avatar URL is issued by the server (AUTH_AVATAR_URL template); the client never invents one.
      assert.equal(payload.avatar, `https://cdn.example.com/avatars/${TEST_OWNER}.png`);
    }
    finally {
      socket.close();
    }
  });

  it('refuses the socket handshake without an identity', async () => {
    const socket = ioClient(`http://127.0.0.1:${port}`, { reconnection: false });

    try {
      const err = await new Promise<Error>((resolve) => {
        socket.on('connect_error', e => resolve(e as Error));
      });
      assert.match(err.message, /Unauthorized/);
    }
    finally {
      socket.close();
    }
  });
});
