import type { Socket } from 'socket.io-client';
import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { Uplink } from '../packages/agent/src/uplink.js';
import { Relay } from '../packages/server/src/relay.js';
import { enrollAgentToken, TEST_AUTH_HEADER, TEST_OWNER, userHeaders } from './relay-auth-helpers.js';

/** The configured "shared token": enrollment no longer issues it, and an agent holding it cannot connect. */
const SHARED_TOKEN = 'test-agent-token';

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

function serverConfig(port: number, dataDir: string): ServerConfig {
  return {
    cdpUrl: 'http://127.0.0.1:9222',
    codebuddyCdpUrl: 'http://127.0.0.1:9223',
    serverPort: port,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
    debounceMs: 150,
    selectorsPath: './selectors.json',
    logLevel: 'error',
    authHeaderName: TEST_AUTH_HEADER,
    windowTitleQualifier: true,
    dataDir,
    mode: 'server',
    remoteUrl: '',
    agentToken: SHARED_TOKEN,
  };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn())
      return true;
    await delay(100);
  }
  return false;
}

interface MachineRow {
  agentId: string;
  hostname?: string;
  connected?: boolean;
  owner?: string;
}

function connectAgent(port: number, token: string, info: { agentId: string; hostname: string }): Socket {
  const socket = ioClient(`http://127.0.0.1:${port}/agent`, {
    path: '/agent-io',
    auth: { agentToken: token },
    transports: ['websocket'],
    reconnection: false,
  });
  socket.on('connect', () => {
    socket.emit('agent:register', { ...info, version: '9.9.9' });
  });
  return socket;
}

function connectBrowser(port: number, userId: string = TEST_OWNER): Socket {
  return ioClient(`http://127.0.0.1:${port}`, {
    extraHeaders: userHeaders(userId),
    transports: ['websocket'],
    reconnection: false,
  });
}

/** Wait for a machine list that matches: register / disconnect both broadcast, so several may arrive. */
function waitForMachines(socket: Socket, want: string[]): Promise<MachineRow[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('machines:list', onList);
      reject(new Error(`machines:list never matched ${JSON.stringify(want)}`));
    }, 5000);
    const onList = (payload: { machines?: MachineRow[] }) => {
      const ids = (payload?.machines ?? []).map(m => m.agentId).sort();
      if (ids.join(',') !== want.slice().sort().join(','))
        return;
      clearTimeout(timer);
      socket.off('machines:list', onList);
      resolve(payload?.machines ?? []);
    };
    socket.on('machines:list', onList);
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('relay machine ownership', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;
  const sockets: Socket[] = [];

  const base = () => `http://127.0.0.1:${port}`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lifeline-owner-'));
    port = await getFreePort();
    relay = new Relay(serverConfig(port, dir));
    await relay.start();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands out a distinct token per machine and rotates the same machine', async () => {
    const aliceUser = 'alice';
    const aliceA = await enrollAgentToken(base(), aliceUser, 'machine-a');
    const aliceB = await enrollAgentToken(base(), aliceUser, 'machine-b');
    const bob = await enrollAgentToken(base(), 'bob', 'machine-a');
    const aliceA2 = await enrollAgentToken(base(), aliceUser, 'machine-a');

    assert.notEqual(aliceA, aliceB, '同一人两台机器各一份 token');
    assert.notEqual(aliceA, bob, '不同人即使同 agentId 也各一份');
    assert.notEqual(aliceA2, aliceA, '同机再 exchange 轮换旧 token');
    assert.notEqual(aliceA, SHARED_TOKEN, '接入流程不再发共享 token');
  });

  it('never shows a machine to anyone but its owner', async () => {
    sockets.push(
      connectAgent(port, await enrollAgentToken(base(), 'alice', 'agent-alice'), {
        agentId: 'agent-alice',
        hostname: 'Alice-MBP',
      }),
      connectAgent(port, await enrollAgentToken(base(), 'bob', 'agent-bob'), {
        agentId: 'agent-bob',
        hostname: 'Bob-Mac',
      }),
      connectAgent(port, await enrollAgentToken(base(), undefined, 'agent-owner'), {
        agentId: 'agent-owner',
        hostname: 'Owner-Mac',
      }),
    );

    const alice = connectBrowser(port, 'alice');
    const bob = connectBrowser(port, 'bob');
    const owner = connectBrowser(port);
    sockets.push(alice, bob, owner);

    assert.deepEqual(
      (await waitForMachines(alice, ['agent-alice'])).map(m => m.agentId),
      ['agent-alice'],
    );
    assert.deepEqual(
      (await waitForMachines(bob, ['agent-bob'])).map(m => m.agentId),
      ['agent-bob'],
    );
    assert.deepEqual(
      (await waitForMachines(owner, ['agent-owner'])).map(m => m.agentId),
      ['agent-owner'],
    );
  });

  it('refuses an agent token nobody enrolled (the shared token is not a credential)', async () => {
    const err = await new Promise<Error>((resolve) => {
      const socket = connectAgent(port, SHARED_TOKEN, { agentId: 'x', hostname: 'X' });
      sockets.push(socket);
      socket.on('connect_error', e => resolve(e as Error));
    });
    assert.match(err.message, /Unauthorized/);
  });

  it('refuses to select or forget somebody else\'s machine', async () => {
    sockets.push(
      connectAgent(port, await enrollAgentToken(base(), 'alice', 'agent-alice'), {
        agentId: 'agent-alice',
        hostname: 'Alice-MBP',
      }),
      connectAgent(port, await enrollAgentToken(base(), 'bob', 'agent-bob'), {
        agentId: 'agent-bob',
        hostname: 'Bob-Mac',
      }),
    );

    const bob = connectBrowser(port, 'bob');
    sockets.push(bob);
    await waitForMachines(bob, ['agent-bob']);

    let stateFulls = 0;
    bob.on('state:full', () => {
      stateFulls += 1;
    });
    bob.emit('machine:select', { agentId: 'agent-alice' });
    await delay(300);
    assert.equal(stateFulls, 0, '点名别人的机器不该收到 state:full');

    bob.emit('machine:select', { agentId: 'agent-bob' });
    await delay(300);
    assert.equal(stateFulls, 1, '自己的机器照常');

    const ack = await new Promise<{ ok: boolean }>((resolve) => {
      bob.emit('machine:forget', { agentId: 'agent-alice' }, resolve);
      setTimeout(resolve, 2000, { ok: true });
    });
    assert.equal(ack.ok, false, '删不掉别人的机器');
  });

  it('scopes /api/health to the caller\'s own machines', async () => {
    sockets.push(
      connectAgent(port, await enrollAgentToken(base(), 'alice', 'agent-alice'), {
        agentId: 'agent-alice',
        hostname: 'Alice-MBP',
      }),
    );
    await delay(300);

    const res = await fetch(`${base()}/api/health`, {
      headers: userHeaders('bob'),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { machines: Array<{ agentId: string }>; agentConnected: boolean };
    assert.deepEqual(body.machines, [], '别人的机器既不在名单里，也不该算作「在线」');
    assert.equal(body.agentConnected, false);
  });

  it('refuses to take over another account\'s machine id', async () => {
    // alice enrolls first and is online
    sockets.push(
      connectAgent(port, await enrollAgentToken(base(), 'alice', 'agent-alice'), {
        agentId: 'agent-alice',
        hostname: 'Alice-MBP',
      }),
    );
    const aliceBrowser = connectBrowser(port, 'alice');
    sockets.push(aliceBrowser);
    await waitForMachines(aliceBrowser, ['agent-alice']);

    // bob takes a token bound to the same agentId and registers: passes the token gate, stuck at the ownership gate
    const intruder = ioClient(`http://127.0.0.1:${port}/agent`, {
      path: '/agent-io',
      auth: { agentToken: await enrollAgentToken(base(), 'bob', 'agent-alice') },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(intruder);
    const rejected = await new Promise<boolean>((resolve) => {
      intruder.on('agent:rejected', () => resolve(true));
      intruder.on('connect', () => {
        intruder.emit('agent:register', {
          agentId: 'agent-alice',
          hostname: 'Alice-MBP',
          version: '9.9.9',
        });
      });
      setTimeout(resolve, 3000, false);
    });
    assert.equal(rejected, true, '服务端要把拒绝原因回给对端');

    // The original owner's machine is unchanged: same name, still online; bob sees nothing
    const aliceHealth = (await (
      await fetch(`${base()}/api/health`, {
        headers: userHeaders('alice'),
      })
    ).json()) as { machines: Array<{ agentId: string; connected: boolean }> };
    assert.deepEqual(aliceHealth.machines.map(m => m.agentId), ['agent-alice']);
    assert.equal(aliceHealth.machines[0].connected, true);

    const bobHealth = (await (
      await fetch(`${base()}/api/health`, {
        headers: userHeaders('bob'),
      })
    ).json()) as { machines: unknown[] };
    assert.deepEqual(bobHealth.machines, []);
  });

  it('rejected machine must re-setup; rotating id with the same token is not enough', async () => {
    sockets.push(
      connectAgent(port, await enrollAgentToken(base(), 'alice', 'machine-taken'), {
        agentId: 'machine-taken',
        hostname: 'Alice-MBP',
      }),
    );

    const bobUser = 'bob';
    const takenToken = await enrollAgentToken(base(), bobUser, 'machine-taken');
    const uplink = new Uplink(base(), takenToken, 'machine-taken');
    try {
      const rejected = await new Promise<boolean>((resolve) => {
        uplink.once('rejected', () => resolve(true));
        setTimeout(resolve, 3000, false);
      });
      assert.equal(rejected, true, 'id 有归属人 → 服务端拒绝，agent 侧要收到事件');
    }
    finally {
      uplink.disconnect();
    }

    // Reusing the same token with a new id is only agent-mismatch; like re-running setup, take a new token for a new id
    sockets.push(
      connectAgent(port, await enrollAgentToken(base(), bobUser, 'machine-bob-fresh'), {
        agentId: 'machine-bob-fresh',
        hostname: 'Bob-Mac',
      }),
    );
    const visible = await waitUntil(async () => {
      const res = await fetch(`${base()}/api/health`, {
        headers: userHeaders(bobUser),
      });
      const body = (await res.json()) as { machines: Array<{ agentId: string }> };
      return body.machines.some(m => m.agentId === 'machine-bob-fresh');
    });
    assert.equal(visible, true, '重跑 setup（新 id + 新 token）后要能接入');

    const aliceRes = await fetch(`${base()}/api/health`, {
      headers: userHeaders('alice'),
    });
    const aliceBody = (await aliceRes.json()) as { machines: Array<{ agentId: string }> };
    assert.deepEqual(aliceBody.machines.map(m => m.agentId), ['machine-taken']);
  });

  it('refuses a per-machine token registering as a different agentId', async () => {
    const header = 'alice';
    const token = await enrollAgentToken(base(), header, 'machine-bound');
    const socket = ioClient(`http://127.0.0.1:${port}/agent`, {
      path: '/agent-io',
      auth: { agentToken: token },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    const reason = await new Promise<string | null>((resolve) => {
      socket.on('agent:rejected', (payload: { reason?: string }) => resolve(payload?.reason ?? 'rejected'));
      socket.on('connect', () => {
        socket.emit('agent:register', { agentId: 'machine-other', hostname: 'X', version: '9.9.9' });
      });
      setTimeout(resolve, 3000, null);
    });
    assert.equal(reason, 'agent-mismatch');
  });

  it('accepts a per-machine token registering as the bound agentId', async () => {
    const header = 'alice';
    const token = await enrollAgentToken(base(), header, 'machine-bound-ok');
    const browser = connectBrowser(port, header);
    sockets.push(browser);
    sockets.push(
      connectAgent(port, token, { agentId: 'machine-bound-ok', hostname: 'Alice-MBP' }),
    );
    const rows = await waitForMachines(browser, ['machine-bound-ok']);
    assert.equal(rows[0]?.agentId, 'machine-bound-ok');
  });
});
