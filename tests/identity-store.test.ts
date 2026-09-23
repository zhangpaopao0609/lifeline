import type { CursorState } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';

function sampleState(): CursorState {
  return {
    ...emptyCursorState(),
    connected: true,
    agentStatus: 'idle',
    _rawSignals: { shimmer: [], loadingIndicator: false, elements: [], orphanIndicators: [] },
  };
}

describe('IdentityStore', () => {
  let dir: string;
  let path: string;
  let seq: number;
  let now: number;
  const open: IdentityStore[] = [];

  function newStore(overrides?: { now?: () => number }): IdentityStore {
    const store = new IdentityStore(path, {
      now: overrides?.now ?? (() => now),
      mint: () => `token-${++seq}`,
    });
    open.push(store);
    return store;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'identity-'));
    path = join(dir, 'identity.sqlite');
    seq = 0;
    now = 1_000;
  });

  afterEach(() => {
    for (const store of open.splice(0)) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('users', () => {
    it('creates a row on first sight and keeps first_seen_at stable', () => {
      const store = newStore();
      assert.equal(store.hasUser('alice'), false);
      store.touchUser('alice');
      assert.equal(store.hasUser('alice'), true);

      now = 10 * 60 * 1000;
      store.touchUser('alice');
      const row = store.loadUsers().find(u => u.userId === 'alice');
      assert.equal(row?.firstSeenAt, 1_000);
      assert.equal(row?.lastSeenAt, now);
    });

    it('throttles last_seen_at writes inside the window', () => {
      const store = newStore();
      store.touchUser('alice');
      now = 1_500;
      store.touchUser('alice'); // inside the throttle window: write nothing
      assert.equal(store.loadUsers().find(u => u.userId === 'alice')?.lastSeenAt, 1_000);

      now = 999_999;
      store.touchUser('alice'); // past the window: refresh last_seen_at
      assert.equal(store.loadUsers().find(u => u.userId === 'alice')?.lastSeenAt, now);
    });

    it('ignores an empty userId', () => {
      const store = newStore();
      store.touchUser('');
      assert.deepEqual(store.loadUsers(), []);
    });
  });

  describe('machine tokens', () => {
    it('mints a distinct token per machine', () => {
      const store = newStore();
      const aliceA = store.mintMachineToken('alice', 'machine-a');
      const aliceB = store.mintMachineToken('alice', 'machine-b');
      const bob = store.mintMachineToken('bob', 'machine-a');
      assert.equal(aliceA, 'token-1');
      assert.equal(aliceB, 'token-2');
      assert.equal(bob, 'token-3');
      assert.deepEqual(store.resolveHandshake(aliceA), { owner: 'alice', agentId: 'machine-a' });
      assert.equal(store.ownerOfToken(aliceB), 'alice');
      assert.equal(store.ownerOfToken(bob), 'bob');
    });

    it('resolves nothing for unknown or empty tokens', () => {
      const store = newStore();
      store.mintMachineToken('alice', 'machine-a');
      assert.equal(store.ownerOfToken('nope'), undefined);
      assert.equal(store.ownerOfToken(''), undefined);
    });

    it('keeps tokens and users across a restart', () => {
      const store = newStore();
      const alice = store.mintMachineToken('alice', 'machine-a');
      store.touchUser('alice');
      const reloaded = newStore();
      assert.deepEqual(reloaded.resolveHandshake(alice), { owner: 'alice', agentId: 'machine-a' });
      assert.equal(reloaded.hasUser('alice'), true);
    });

    it('stores only the hash and rotates the previous token for the same machine', () => {
      const store = newStore();
      const first = store.mintMachineToken('alice', 'machine-a');
      assert.equal(first, 'token-1');
      assert.deepEqual(store.resolveHandshake(first), { owner: 'alice', agentId: 'machine-a' });
      const second = store.mintMachineToken('alice', 'machine-a');
      assert.equal(second, 'token-2');
      assert.equal(store.resolveHandshake(first), undefined, 'rotated token is revoked');
      assert.deepEqual(store.resolveHandshake(second), { owner: 'alice', agentId: 'machine-a' });
    });
  });

  describe('machines', () => {
    it('round-trips a machine and strips _rawSignals', () => {
      const store = newStore();
      store.upsertMachine({
        agentId: 'agent-a',
        hostname: 'mbp',
        lastSeenAt: 1000,
        snapshot: sampleState(),
      });
      const rows = newStore().loadMachines();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].agentId, 'agent-a');
      assert.equal(rows[0].hostname, 'mbp');
      assert.equal(rows[0].lastSeenAt, 1000);
      assert.equal(rows[0].updatedAt, 1_000);
      const cursor
        = rows[0].snapshot && 'ides' in rows[0].snapshot ? rows[0].snapshot.ides.cursor : undefined;
      assert.equal(cursor?.connected, true);
      assert.equal(cursor?.messages.length, 0);
      assert.equal(cursor?._rawSignals, undefined);
    });

    it('upserts by agentId but keeps the owner of the first enrollment', () => {
      const store = newStore();
      store.upsertMachine({
        agentId: 'a',
        hostname: 'old',
        lastSeenAt: 1,
        snapshot: null,
        owner: 'alice',
      });
      store.upsertMachine({
        agentId: 'a',
        hostname: 'new',
        lastSeenAt: 2,
        snapshot: null,
        owner: 'bob',
      });
      const rows = store.loadMachines();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hostname, 'new', '机器信息照常刷新');
      assert.equal(rows[0].owner, 'alice', '归属不再被改写（注册闸是第一道，这里是第二道）');
    });

    it('fills in an owner for a machine that had none', () => {
      const store = newStore();
      store.upsertMachine({ agentId: 'a', hostname: 'x', lastSeenAt: 1, snapshot: null });
      store.upsertMachine({
        agentId: 'a',
        hostname: 'x',
        lastSeenAt: 2,
        snapshot: null,
        owner: 'alice',
      });
      assert.equal(store.loadMachines()[0].owner, 'alice', '无主行补归属仍然允许');
    });

    it('persists the CLI version, and forgets it when an old agent re-registers', () => {
      const store = newStore();
      store.upsertMachine({
        agentId: 'a',
        hostname: 'A',
        lastSeenAt: 1,
        snapshot: null,
        cliVersion: '0.1.52',
      });
      assert.equal(store.loadMachines()[0].cliVersion, '0.1.52');
      // Old agent reports no version: keeping the old value becomes a lie (the web UI would think it is on the new build)
      store.upsertMachine({ agentId: 'a', hostname: 'A', lastSeenAt: 2, snapshot: null });
      assert.equal(store.loadMachines()[0].cliVersion, undefined);
    });

    it('keeps the display name across upserts, id adoption, and clears it on demand', () => {
      const store = newStore();
      store.upsertMachine({ agentId: 'a', hostname: 'Mac-mini.local', lastSeenAt: 1, snapshot: null });
      assert.equal(store.loadMachines()[0].displayName, undefined, '没起名时就是没有');

      store.setDisplayName('a', '客厅的 Mac mini');
      assert.equal(newStore().loadMachines()[0].displayName, '客厅的 Mac mini', '落盘且能读回');

      // Every state:patch upserts: hostname refreshes from the machine's self-report; the alias must not be overwritten
      store.upsertMachine({ agentId: 'a', hostname: 'Mac-mini.local', lastSeenAt: 2, snapshot: null });
      assert.equal(store.loadMachines()[0].displayName, '客厅的 Mac mini');

      // Retired old agent re-enrolls (same row, new primary key): the alias follows
      store.renameMachine('a', 'machine-new');
      const row = store.loadMachines()[0];
      assert.equal(row.agentId, 'machine-new');
      assert.equal(row.displayName, '客厅的 Mac mini');

      store.setDisplayName('machine-new', null);
      assert.equal(store.loadMachines()[0].displayName, undefined);
    });

    it('setDisplayName of an unknown id does not throw', () => {
      const store = newStore();
      store.setDisplayName('missing', 'x');
      assert.deepEqual(store.loadMachines(), []);
    });

    it('remove drops one id and keeps the others', () => {
      const store = newStore();
      store.upsertMachine({ agentId: 'a', hostname: 'A', lastSeenAt: 1, snapshot: null });
      store.upsertMachine({ agentId: 'b', hostname: 'B', lastSeenAt: 2, snapshot: null });
      store.removeMachine('a');
      const rows = store.loadMachines();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].agentId, 'b');
    });

    it('remove of an unknown id does not throw', () => {
      const store = newStore();
      store.removeMachine('missing');
      assert.deepEqual(store.loadMachines(), []);
    });

    it('lists an empty table before anything registered', () => {
      assert.deepEqual(newStore().loadMachines(), []);
    });
  });
});
