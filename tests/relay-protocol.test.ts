import type { Socket } from 'socket.io-client';
import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';
import { Relay } from '../packages/server/src/relay.js';
import { enrollAgentToken, TEST_AUTH_HEADER, TEST_OWNER, userHeaders } from './relay-auth-helpers.js';

/**
 * An agent must present the **machine token** issued at enroll (unknown owner or id mismatch → reject).
 * Each agentId gets its own; reuse the same id within a case so a second exchange does not revoke the live token.
 */
const SHARED_TOKEN = 'test-agent-token';

/** The server release version on machines:list = package.json (the same number build:cli bakes into the CLI). */
const SERVER_VERSION = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
  ) as { version: string }
).version;

interface MachineRow {
  agentId: string;
  hostname: string;
  displayName?: string;
  connected: boolean;
  lastSeenAt: number;
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

async function waitUntil(fn: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs)
      throw new Error('waitUntil timeout');
    await new Promise(r => setTimeout(r, 15));
  }
}

async function connectClient(url: string, auth?: Record<string, string>): Promise<Socket> {
  const sock = ioClient(url, {
    path: '/agent-io',
    transports: ['websocket'],
    auth,
    autoConnect: false,
    reconnection: false,
    forceNew: true,
  });
  const connected = new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('connect_error', err => reject(err));
  });
  sock.connect();
  await connected;
  return sock;
}

describe('relay protocol (MODE=server)', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;
  let enrolled = new Map<string, Promise<string>>();
  const sockets: Socket[] = [];

  const agentToken = (agentId: string): Promise<string> => {
    let pending = enrolled.get(agentId);
    if (!pending) {
      pending = enrollAgentToken(`http://127.0.0.1:${port}`, undefined, agentId);
      enrolled.set(agentId, pending);
    }
    return pending;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-proto-'));
    port = await getFreePort();
    relay = new Relay(serverConfig(port, dir));
    await relay.start();
    enrolled = new Map();
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      s.removeAllListeners();
      s.disconnect();
    }
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A different `loginName` is "someone else's" browser (used to isolate machine ownership). */
  async function connectBrowser(loginName = TEST_OWNER): Promise<{
    sock: Socket;
    events: Record<string, unknown[]>;
  }> {
    const sock = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      extraHeaders: userHeaders(loginName),
    });
    const events: Record<string, unknown[]> = {
      'machines:list': [],
      'agent:uplink': [],
      'state:full': [],
      'state:patch': [],
      'connection:status': [],
      'command:result': [],
    };
    for (const ev of Object.keys(events)) {
      sock.on(ev, (p: unknown) => events[ev].push(p));
    }
    const connected = new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('connect_error', err => reject(err));
    });
    sock.connect();
    await connected;
    sockets.push(sock);
    return { sock, events };
  }

  async function connectAgent(info: {
    agentId: string;
    hostname: string;
    version?: string;
  }): Promise<Socket> {
    const sock = await connectClient(`http://127.0.0.1:${port}/agent`, {
      agentToken: await agentToken(info.agentId),
    });
    sock.emit('agent:register', info);
    // Let the register packet land before callers may disconnect — an emit
    // followed by disconnect() in the same tick drops the register packet.
    await new Promise(r => setTimeout(r, 50));
    sockets.push(sock);
    return sock;
  }

  it('rejects agent connections with a bad token on /agent-io', async () => {
    await assert.rejects(
      () => connectClient(`http://127.0.0.1:${port}/agent`, { agentToken: 'wrong' }),
      /Unauthorized/,
    );
  });

  it('emits machines:list and agent:uplink on connect, not state:full', async () => {
    const { events } = await connectBrowser();
    await waitUntil(() => events['machines:list'].length > 0 && events['agent:uplink'].length > 0);
    // cliLatest = this machine's release version; the web UI uses it to mark lagging machines as "updatable"
    assert.deepEqual(events['machines:list'][0], { machines: [], cliLatest: SERVER_VERSION });
    assert.deepEqual(events['agent:uplink'][0], { connected: false });
    assert.equal(events['state:full'].length, 0);
  });

  it('publishes the CLI version an agent registers with', async () => {
    await connectAgent({ agentId: 'agent-a', hostname: 'mbp', version: '0.0.1' });
    const { events } = await connectBrowser();
    await waitUntil(() =>
      (events['machines:list'] as Array<{ machines: Array<{ agentId: string }> }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a'),
      ),
    );
    const payload = events['machines:list'][0] as {
      machines: Array<{ agentId: string; cliVersion?: string }>;
      cliLatest: string;
    };
    assert.equal(payload.machines[0].cliVersion, '0.0.1');
    assert.equal(payload.cliLatest, SERVER_VERSION);
  });

  it('machine:select of a known id binds and emits that machine state:full', async () => {
    const a = await connectAgent({ agentId: 'agent-a', hostname: 'mbp' });
    a.emit('state:full', { ...emptyCursorState(), connected: true, agentActivityText: 'hello-a' });
    const { sock, events } = await connectBrowser();
    await waitUntil(() =>
      (events['machines:list'] as Array<{ machines: MachineRow[] }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a' && m.connected),
      ),
    );
    sock.emit('machine:select', { agentId: 'agent-a' });
    await waitUntil(() => events['state:full'].length > 0);
    const full = events['state:full'][0] as { ides?: { cursor?: { agentActivityText: string | null } } };
    assert.equal(full.ides?.cursor?.agentActivityText, 'hello-a');
  });

  it('unknown machine:select does not change the current binding', async () => {
    const a = await connectAgent({ agentId: 'agent-a', hostname: 'A' });
    const b = await connectAgent({ agentId: 'agent-b', hostname: 'B' });
    a.emit('state:full', { ...emptyCursorState(), agentActivityText: 'from-a' });
    b.emit('state:full', { ...emptyCursorState(), agentActivityText: 'from-b' });

    const { sock, events } = await connectBrowser();
    await waitUntil(() =>
      (events['machines:list'] as Array<{ machines: MachineRow[] }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a')
        && p.machines.some(m => m.agentId === 'agent-b'),
      ),
    );
    sock.emit('machine:select', { agentId: 'agent-a' });
    await waitUntil(() => events['state:full'].length > 0);
    const afterSelect = events['state:full'].length;

    sock.emit('machine:select', { agentId: 'does-not-exist' });
    await new Promise(r => setTimeout(r, 80));
    assert.equal(events['state:full'].length, afterSelect);

    const patchCount = events['state:patch'].length;
    a.emit('state:patch', { agentActivityText: 'still-a' });
    await waitUntil(() => events['state:patch'].length > patchCount);
    const patch = events['state:patch'].at(-1) as { ide?: string; patch?: { agentActivityText: string } };
    assert.equal(patch.ide, 'cursor');
    assert.equal(patch.patch?.agentActivityText, 'still-a');
  });

  it('unselected command path returns Machine offline', async () => {
    const { sock, events } = await connectBrowser();
    await waitUntil(() => events['agent:uplink'].length > 0);
    sock.emit('command:new_chat', { commandId: 'c1', type: 'new_chat' });
    await waitUntil(() => events['command:result'].length > 0);
    assert.deepEqual(events['command:result'][0], {
      commandId: 'c1',
      ok: false,
      error: 'Machine offline',
    });
  });

  it('forwards state only to browsers bound to that agentId', async () => {
    const a = await connectAgent({ agentId: 'agent-a', hostname: 'A' });
    const b = await connectAgent({ agentId: 'agent-b', hostname: 'B' });
    a.emit('state:full', { ...emptyCursorState(), agentActivityText: 'a0' });
    b.emit('state:full', { ...emptyCursorState(), agentActivityText: 'b0' });

    const viewerA = await connectBrowser();
    const viewerB = await connectBrowser();
    viewerA.sock.emit('machine:select', { agentId: 'agent-a' });
    viewerB.sock.emit('machine:select', { agentId: 'agent-b' });
    await Promise.all([
      waitUntil(() => viewerA.events['state:full'].length > 0),
      waitUntil(() => viewerB.events['state:full'].length > 0),
    ]);

    a.emit('state:patch', { agentActivityText: 'a1' });
    await waitUntil(() => viewerA.events['state:patch'].length > 0);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(viewerB.events['state:patch'].length, 0);
  });

  it('/api/health includes machines and agentConnected, not a snapshot', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: userHeaders(TEST_OWNER),
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.agentConnected, false);
    assert.deepEqual(body.machines, []);
    assert.equal('snapshot' in body, false);
  });

  it('machine:forget removes an offline machine and notifies all viewers', async () => {
    const agent = await connectAgent({ agentId: 'agent-a', hostname: 'mbp' });
    agent.disconnect();
    const viewerA = await connectBrowser();
    const viewerB = await connectBrowser();
    await waitUntil(() =>
      (viewerA.events['machines:list'] as Array<{ machines: MachineRow[] }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a' && !m.connected),
      ),
    );

    const ack = await new Promise<{ ok: boolean }>((resolve) => {
      viewerA.sock.emit('machine:forget', { agentId: 'agent-a' }, resolve);
    });
    assert.equal(ack.ok, true);

    await waitUntil(() =>
      (viewerA.events['machines:list'] as Array<{ machines: MachineRow[] }>).some(
        p => p.machines.length === 0,
      )
      && (viewerB.events['machines:list'] as Array<{ machines: MachineRow[] }>).some(
        p => p.machines.length === 0,
      ),
    );
  });

  it('machine:forget of an online machine is rejected', async () => {
    await connectAgent({ agentId: 'agent-a', hostname: 'mbp' });
    const { sock, events } = await connectBrowser();
    await waitUntil(() =>
      (events['machines:list'] as Array<{ machines: MachineRow[] }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a' && m.connected),
      ),
    );
    const listsBefore = events['machines:list'].length;
    const ack = await new Promise<{ ok: boolean }>((resolve) => {
      sock.emit('machine:forget', { agentId: 'agent-a' }, resolve);
    });
    assert.equal(ack.ok, false);
    await new Promise(r => setTimeout(r, 80));
    const last = events['machines:list'].at(-1) as { machines: MachineRow[] };
    assert.equal(last.machines.some(m => m.agentId === 'agent-a'), true);
    assert.equal(events['machines:list'].length, listsBefore);
  });

  it('machine:rename broadcasts the alias to every viewer and keeps the hostname', async () => {
    await connectAgent({ agentId: 'agent-a', hostname: 'Mac-mini.local' });
    const viewerA = await connectBrowser();
    const viewerB = await connectBrowser();
    await waitUntil(() =>
      (viewerB.events['machines:list'] as Array<{ machines: MachineRow[] }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a'),
      ),
    );

    const ack = await new Promise<{ ok: boolean }>((resolve) => {
      viewerA.sock.emit('machine:rename', { agentId: 'agent-a', displayName: '  客厅的 Mac   ' }, resolve);
    });
    assert.equal(ack.ok, true);

    // A rename must broadcast to every open web client (not just the initiator); hostname is kept as-is (machine self-report, never rewritten)
    await waitUntil(() =>
      (viewerB.events['machines:list'] as Array<{ machines: MachineRow[] }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a' && m.displayName === '客厅的 Mac'),
      ),
    );
    const renamed = (viewerB.events['machines:list'].at(-1) as { machines: MachineRow[] }).machines.find(
      m => m.agentId === 'agent-a',
    );
    assert.equal(renamed?.hostname, 'Mac-mini.local');

    // Empty string = clear the alias, fall back to hostname
    const cleared = await new Promise<{ ok: boolean }>((resolve) => {
      viewerB.sock.emit('machine:rename', { agentId: 'agent-a', displayName: '  ' }, resolve);
    });
    assert.equal(cleared.ok, true);
    await waitUntil(() =>
      (viewerA.events['machines:list'] as Array<{ machines: MachineRow[] }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a' && !m.displayName),
      ),
    );
  });

  it('machine:rename refuses another account and non-string names', async () => {
    await connectAgent({ agentId: 'agent-a', hostname: 'mbp' });
    const owner = await connectBrowser();
    await waitUntil(() =>
      (owner.events['machines:list'] as Array<{ machines: MachineRow[] }>).some(p =>
        p.machines.some(m => m.agentId === 'agent-a'),
      ),
    );
    const other = await connectBrowser('bob');
    // Connected does not mean the first machines:list has arrived (the server emits it after connect) — wait
    await waitUntil(() => other.events['machines:list'].length > 0);
    assert.deepEqual((other.events['machines:list'][0] as { machines: MachineRow[] }).machines, []);

    const denied = await new Promise<{ ok: boolean }>((resolve) => {
      other.sock.emit('machine:rename', { agentId: 'agent-a', displayName: '偷改' }, resolve);
    });
    assert.equal(denied.ok, false);

    // Anything that is not string / not null is illegal; must not silently clear the name
    const badType = await new Promise<{ ok: boolean }>((resolve) => {
      owner.sock.emit('machine:rename', { agentId: 'agent-a', displayName: 42 }, resolve);
    });
    assert.equal(badType.ok, false);

    await new Promise(r => setTimeout(r, 80));
    const row = (owner.events['machines:list'].at(-1) as { machines: MachineRow[] }).machines.find(
      m => m.agentId === 'agent-a',
    );
    assert.equal(row?.displayName, undefined, '两次被拒的请求都不该改动名单');
  });

  it('stop() returns quickly even with live browser and agent sockets', async () => {
    await connectBrowser();
    await connectAgent({ agentId: 'agent-a', hostname: 'mbp' });
    const t0 = Date.now();
    await relay.stop();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `stop() hung for ${elapsed}ms with live sockets`);
  });

  it('stop() is idempotent after a first successful stop', async () => {
    await relay.stop();
    const t0 = Date.now();
    await relay.stop();
    assert.ok(Date.now() - t0 < 500, 'second stop() should be a no-op');
  });
});
