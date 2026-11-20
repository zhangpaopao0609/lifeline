import type { Socket } from 'socket.io-client';
import type { ServerConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { normalizeSessionGroupsPut, Relay } from '../packages/server/src/relay.js';
import { userHeaders } from './relay-auth-helpers.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 校验（纯函数）

describe('normalizeSessionGroupsPut', () => {
  const groups = [{ id: 'g1', name: '工作', sortOrder: 1 }];

  it('accepts a legal payload and trims names', () => {
    const out = normalizeSessionGroupsPut({
      groups: [{ id: 'g1', name: '  工作  ', sortOrder: 1 }],
      assignments: { 'sess-a': 'g1' },
    });
    assert.deepEqual(out, { groups: [{ id: 'g1', name: '工作', sortOrder: 1 }], assignments: { 'sess-a': 'g1' } });
  });

  it('rejects non-objects, missing arrays and over-cap group counts', () => {
    assert.equal(normalizeSessionGroupsPut(null), null);
    assert.equal(normalizeSessionGroupsPut('x'), null);
    assert.equal(normalizeSessionGroupsPut({ assignments: {} }), null, '缺 groups');
    assert.equal(normalizeSessionGroupsPut({ groups: 'x', assignments: {} }), null);
    const tooMany = Array.from({ length: 65 }, (_, i) => ({ id: `g${i}`, name: 'x', sortOrder: i }));
    assert.equal(normalizeSessionGroupsPut({ groups: tooMany, assignments: {} }), null, '超过 64 个分组');
  });

  it('rejects bad ids, blank/oversized names, bad sort orders and duplicate ids', () => {
    assert.equal(normalizeSessionGroupsPut({ groups: [{ id: '', name: 'x', sortOrder: 0 }], assignments: {} }), null);
    assert.equal(normalizeSessionGroupsPut({ groups: [{ id: 'g1', name: '', sortOrder: 0 }], assignments: {} }), null);
    assert.equal(normalizeSessionGroupsPut({ groups: [{ id: 'g1', name: 'x'.repeat(61), sortOrder: 0 }], assignments: {} }), null);
    assert.equal(normalizeSessionGroupsPut({ groups: [{ id: 'g1', name: 'x', sortOrder: -1 }], assignments: {} }), null);
    assert.equal(normalizeSessionGroupsPut({ groups: [{ id: 'g1', name: 'x', sortOrder: 'a' }], assignments: {} }), null);
    assert.equal(
      normalizeSessionGroupsPut({
        groups: [{ id: 'g1', name: 'a', sortOrder: 0 }, { id: 'g1', name: 'b', sortOrder: 1 }],
        assignments: {},
      }),
      null,
      '重复 id',
    );
  });

  it('rejects assignments pointing at unknown groups', () => {
    assert.equal(normalizeSessionGroupsPut({ groups, assignments: { 'sess-a': 'nope' } }), null);
    assert.equal(normalizeSessionGroupsPut({ groups, assignments: { '': 'g1' } }), null);
    assert.equal(normalizeSessionGroupsPut({ groups, assignments: { 'sess-a': 1 } }), null);
    assert.equal(normalizeSessionGroupsPut({ groups, assignments: [] }), null);
  });

  it('caps assignments at 1000', () => {
    const assignments: Record<string, string> = {};
    for (let i = 0; i < 1001; i++) assignments[`s${i}`] = 'g1';
    assert.equal(normalizeSessionGroupsPut({ groups, assignments }), null);
    delete assignments.s1000;
    assert.ok(normalizeSessionGroupsPut({ groups, assignments }), '1000 条恰好通过');
  });
});

// ---------------------------------------------------------------- 持久化（IdentityStore）

describe('IdentityStore session groups', () => {
  let dir: string;
  let path: string;
  const open: IdentityStore[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'identity-groups-'));
    path = join(dir, 'identity.sqlite');
  });

  afterEach(() => {
    for (const store of open.splice(0)) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips groups and assignments per user, isolated across users', () => {
    const store = new IdentityStore(path);
    open.push(store);
    store.putSessionGroups('alice', {
      groups: [{ id: 'g1', name: '工作', sortOrder: 2 }, { id: 'g2', name: '调研', sortOrder: 1 }],
      assignments: { 'sess-a': 'g1' },
    });
    store.putSessionGroups('bob', { groups: [{ id: 'b1', name: 'Bob 的组', sortOrder: 0 }], assignments: {} });

    const alice = store.sessionGroupsOf('alice');
    assert.deepEqual(alice.groups.map(g => g.id), ['g2', 'g1'], '按 sortOrder 排序');
    assert.deepEqual(alice.assignments, { 'sess-a': 'g1' });
    assert.deepEqual(store.sessionGroupsOf('bob').groups.map(g => g.id), ['b1'], '用户间隔离');
    assert.deepEqual(store.sessionGroupsOf('nobody'), { groups: [], assignments: {} });

    // 全量覆盖语义：重命名 + 删组 + 挪归属一次完成；孤儿归属被兜底剔除
    store.putSessionGroups('alice', {
      groups: [{ id: 'g2', name: '调研（改名）', sortOrder: 0 }],
      assignments: { 'sess-a': 'g1', 'sess-b': 'g2' },
    });
    const after = store.sessionGroupsOf('alice');
    assert.deepEqual(after.groups.map(g => g.name), ['调研（改名）']);
    assert.deepEqual(after.assignments, { 'sess-b': 'g2' }, '指向已删组的归属被剔除');
  });

  it('survives a reopen (WAL db on disk)', () => {
    const first = new IdentityStore(path);
    open.push(first);
    first.putSessionGroups('alice', { groups: [{ id: 'g1', name: '持久', sortOrder: 0 }], assignments: { 'sess-a': 'g1' } });
    first.close();
    open.pop();

    const second = new IdentityStore(path);
    open.push(second);
    assert.deepEqual(second.sessionGroupsOf('alice').groups.map(g => g.name), ['持久']);
  });
});

// ---------------------------------------------------------------- relay 事件（推送 + 广播 + 隔离）

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
    authHeaderName: 'x-test-user',
    windowTitleQualifier: true,
    dataDir,
    mode: 'server',
    remoteUrl: '',
    agentToken: 'unused',
  };
}

function connectBrowser(port: number, userId: string): Socket {
  return ioClient(`http://127.0.0.1:${port}`, {
    extraHeaders: userHeaders(userId),
    transports: ['websocket'],
    reconnection: false,
  });
}

/** 等到一条合法的 session-groups:list（连接建立时的初始推送）。 */
function waitInitialGroups(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onList = (payload: { groups?: unknown }) => {
      if (!Array.isArray(payload?.groups))
        return;
      clearTimeout(timer);
      socket.off('session-groups:list', onList);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.off('session-groups:list', onList);
      reject(new Error('session-groups:list never arrived'));
    }, 5000);
    socket.on('session-groups:list', onList);
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface GroupsPayload {
  groups: Array<{ id: string; name: string; sortOrder: number }>;
  assignments: Record<string, string>;
}

describe('relay session groups', { concurrency: 1 }, () => {
  let dir: string;
  let port: number;
  let relay: Relay;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lifeline-groups-'));
    port = await getFreePort();
    relay = new Relay(serverConfig(port, dir));
    await relay.start();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await relay.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pushes the user state on connect, acks a legal put, and isolates other users', async () => {
    const alice = connectBrowser(port, 'alice');
    const bob = connectBrowser(port, 'bob');
    sockets.push(alice, bob);
    await waitInitialGroups(alice);
    await waitInitialGroups(bob);

    // bob 侧只记录 alice 的组名出现（不应出现）
    const bobSawAliceGroup: string[] = [];
    bob.on('session-groups:list', (payload: GroupsPayload) => {
      for (const g of payload?.groups ?? []) {
        if (g.id === 'g1')
          bobSawAliceGroup.push(g.id);
      }
    });

    const putResult: Array<{ ok?: boolean }> = [];
    alice.emit('session-groups:put', {
      groups: [{ id: 'g1', name: '工作', sortOrder: 0 }],
      assignments: { 'sess-a': 'g1' },
    }, (r: { ok?: boolean }) => putResult.push(r));
    await delay(300);
    assert.equal(putResult.length, 1, 'put 有 ack');
    assert.equal(putResult[0].ok, true);
    assert.deepEqual(bobSawAliceGroup, [], 'bob 收不到 alice 的分组（用户隔离）');

    // get 回来的是 alice 自己的状态
    const got: GroupsPayload[] = [];
    alice.emit('session-groups:get', {}, (r: GroupsPayload) => got.push(r));
    await delay(150);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].groups.map(g => g.name), ['工作']);
    assert.deepEqual(got[0].assignments, { 'sess-a': 'g1' });
  });

  it('rejects an illegal put without broadcasting or persisting', async () => {
    const alice = connectBrowser(port, 'alice');
    sockets.push(alice);
    await waitInitialGroups(alice);

    const lists: GroupsPayload[] = [];
    alice.on('session-groups:list', (payload: GroupsPayload) => lists.push(payload));
    const putResult: Array<{ ok?: boolean }> = [];
    alice.emit('session-groups:put', { groups: [{ id: 'g1', name: '', sortOrder: 0 }], assignments: {} }, (r: { ok?: boolean }) => putResult.push(r));
    await delay(200);
    assert.equal(putResult[0]?.ok, false, '非法 put 被拒');
    assert.equal(lists.length, 0, '拒绝时不广播');

    const got: GroupsPayload[] = [];
    alice.emit('session-groups:get', {}, (r: GroupsPayload) => got.push(r));
    await delay(150);
    assert.deepEqual(got[0], { groups: [], assignments: {} }, '也没有落库');
  });

  it('broadcasts the put to the same user and persists it for the next connection', async () => {
    const a1 = connectBrowser(port, 'alice');
    sockets.push(a1);
    await waitInitialGroups(a1);

    const seen: GroupsPayload[] = [];
    a1.on('session-groups:list', (payload: GroupsPayload) => seen.push(payload));
    a1.emit('session-groups:put', {
      groups: [{ id: 'g1', name: '工作', sortOrder: 0 }],
      assignments: { 'sess-a': 'g1' },
    }, (r: { ok?: boolean }) => assert.equal(r.ok, true));
    await delay(200);
    assert.ok(seen.some(p => p.groups.some(g => g.id === 'g1')), '同 user room 的页面收到广播');

    // 新连接（模拟另一台设备 / 刷新）：初始推送里就是这份状态
    const a2 = connectBrowser(port, 'alice');
    sockets.push(a2);
    const initial = await new Promise<GroupsPayload>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no initial push')), 5000);
      a2.on('session-groups:list', (payload: GroupsPayload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    assert.deepEqual(initial.groups.map(g => g.name), ['工作']);
    assert.deepEqual(initial.assignments, { 'sess-a': 'g1' });
  });
});
