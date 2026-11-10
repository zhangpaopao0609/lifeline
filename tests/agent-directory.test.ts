import type { SessionMeta } from '../packages/agent/src/sources/types.js';
import type { AgentPlatform } from '../packages/protocol/src/index.js';
import type { AgentSocket } from '../packages/server/src/agent-hub.js';
import type { ChatElement, CommandPayload, CommandResult } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MACHINE_NAME_MAX_LENGTH } from '../packages/protocol/src/index.js';
import {
  AgentDirectory,

  normalizeMachineName,
} from '../packages/server/src/agent-hub.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';
import { SessionStore } from '../packages/server/src/session-store.js';

function fakeSocket(id: string): AgentSocket & { events: Array<[string, unknown[]]> } {
  const events: Array<[string, unknown[]]> = [];
  return {
    id,
    connected: true,
    events,
    emit(event: string, ...args: unknown[]) {
      events.push([event, args]);
    },
  };
}

function sessionMeta(sessionId: string): SessionMeta {
  return {
    ref: { ide: 'codebuddy', workspaceId: 'ws1', sessionId },
    title: sessionId,
    createdAt: 1,
    lastUpdatedAt: 2,
    isArchived: false,
    isSubagent: false,
    status: 'idle',
    messageCount: 1,
  };
}

function human(id: string): ChatElement {
  return { type: 'human', id, flatIndex: 0, text: 'hi', mentions: [] };
}

describe('AgentDirectory', () => {
  let dir: string;
  let store: IdentityStore;
  let sessionStore: SessionStore;
  let d: AgentDirectory;
  /**
   * **Every** `IdentityStore` created in this file — `afterEach` must close them one by one.
   *
   * Why: `identity.sqlite` is a better-sqlite3 **real file handle**. We used to `close()` only
   * `sessionStore`, leaving the `IdentityStore` handle open; macOS/Linux **allow unlinking an
   * open file**, Windows does not → `rmSync` raises `EBUSY: resource busy or locked, unlink
   * ...\identity.sqlite` (measured here: all 38 cases in this suite failed). Production does
   * close (`relay.ts`); only the tests leaked. Extra lines buy "Windows `npm test` is a real gate".
   */
  const stores: IdentityStore[] = [];
  const newStore = (name = 'identity.sqlite'): IdentityStore => {
    const created = new IdentityStore(join(dir, name));
    stores.push(created);
    return created;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-'));
    store = newStore();
    sessionStore = new SessionStore(join(dir, 'sessions.sqlite'));
    d = new AgentDirectory(store, { persistDebounceMs: 0, now: () => 50, sessionStore });
  });

  afterEach(() => {
    sessionStore.close();
    for (const s of stores) {
      try {
        s.close();
      }
      catch {
        /* already closed / never opened */
      }
    }
    stores.length = 0;
    // maxRetries is the Windows fallback: unlink can still EBUSY after close while the FS has not released the handle.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('keeps the CLI version an agent reports, drops it for old agents', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'A', version: '0.1.52' });
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'B' });
    const before = d.listMachines();
    assert.equal(before.find(m => m.agentId === 'agent-a')?.cliVersion, '0.1.52');
    assert.equal(before.find(m => m.agentId === 'agent-b')?.cliVersion, undefined);

    // Downgrade to an old CLI (no version): must not keep the previous version number and claim it is current
    d.register(fakeSocket('sa2'), { agentId: 'agent-a', hostname: 'A' });
    assert.equal(d.listMachines().find(m => m.agentId === 'agent-a')?.cliVersion, undefined);
  });

  /**
   * The web ⋯ menu issues uninstall/upgrade commands for **this machine** from `listMachines()`
   * platform. It must: accept on register, not be cleared when an old agent reconnects, and
   * survive a server restart (offline machines still need the right command).
   */
  it('keeps the platform a machine reports, and remembers it after a restart', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'DESKTOP-1', platform: 'win32' });
    assert.equal(d.listMachines()[0].platform, 'win32');

    // Downgrade / old agent takeover (no platform): platform is a machine property and must not be cleared
    d.register(fakeSocket('sa2'), { agentId: 'agent-a', hostname: 'DESKTOP-1' });
    assert.equal(d.listMachines()[0].platform, 'win32');

    // Server restart: comes back from the machines table
    const reloaded = new AgentDirectory(store, { persistDebounceMs: 0, now: () => 60, sessionStore });
    assert.equal(reloaded.listMachines()[0].platform, 'win32');

    // Unrecognised platform values (hand-edited DB / a future new platform) count as unreported, stay off the wire
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'BSD', platform: 'freebsd' as AgentPlatform });
    assert.equal(d.listMachines().find(m => m.agentId === 'agent-b')?.platform, undefined);
    assert.equal(d.listMachines().find(m => m.agentId === 'agent-a')?.platform, 'win32', '别人乱报不影响这台');
  });

  it('restores the persisted CLI version for an offline machine', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A', version: '0.1.52' });
    d.onSocketDisconnect(a);
    // Server restart: reload the same identity.sqlite
    const reloaded = new AgentDirectory(store, { persistDebounceMs: 0, now: () => 60, sessionStore });
    const row = reloaded.listMachines().find(m => m.agentId === 'agent-a');
    assert.equal(row?.connected, false);
    assert.equal(row?.cliVersion, '0.1.52');
  });

  it('renames a machine without touching its hostname, and the alias survives a restart', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'Mac-mini.local' });
    assert.equal(d.listMachines()[0].displayName, undefined, '默认没有别名，网页显示 hostname');

    assert.equal(d.setDisplayName('agent-a', '客厅的 Mac mini'), true);
    const renamed = d.listMachines().find(m => m.agentId === 'agent-a');
    assert.equal(renamed?.displayName, '客厅的 Mac mini');
    assert.equal(renamed?.hostname, 'Mac-mini.local', 'hostname 是机器自报的，改名不动它');

    // Agent reconnect (reports the same hostname) must not wipe the alias
    d.register(fakeSocket('sa2'), { agentId: 'agent-a', hostname: 'Mac-mini.local' });
    assert.equal(d.listMachines()[0].displayName, '客厅的 Mac mini');

    // Server restart: alias comes back from the machines table
    const reloaded = new AgentDirectory(store, { persistDebounceMs: 0, now: () => 60, sessionStore });
    assert.equal(reloaded.listMachines()[0].displayName, '客厅的 Mac mini');

    assert.equal(d.setDisplayName('agent-a', null), true, 'null = 清除别名，回 hostname');
    assert.equal(d.listMachines()[0].displayName, undefined);

    assert.equal(d.setDisplayName('does-not-exist', 'x'), false, '名单里没有的机器改不了');
  });

  it('routes a command only to the bound agent', () => {
    const a = fakeSocket('sa');
    const b = fakeSocket('sb');
    const browser = fakeSocket('br');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.register(b, { agentId: 'agent-b', hostname: 'B' });
    const payload = { commandId: 'c1', type: 'new_chat' } satisfies CommandPayload;
    d.sendCommand('agent-a', 'command:new_chat', payload, browser);
    assert.equal(a.events.some(e => e[0] === 'command:new_chat'), true);
    assert.equal(b.events.some(e => e[0] === 'command:new_chat'), false);
  });

  it('does not promote another machine on disconnect', () => {
    const a = fakeSocket('sa');
    const b = fakeSocket('sb');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.register(b, { agentId: 'agent-b', hostname: 'B' });
    // A new ledger already syncs once on register (so the agent re-reports its census); here we only look at the moment "someone else disconnects".
    b.events.length = 0;
    d.applyFull(a, { ...emptyCursorState(), connected: true });
    d.onSocketDisconnect(a);
    const list = d.listMachines();
    const rowA = list.find(m => m.agentId === 'agent-a')!;
    const rowB = list.find(m => m.agentId === 'agent-b')!;
    assert.equal(rowA.connected, false);
    assert.equal(rowB.connected, true);
    assert.equal(d.getState('agent-a')?.ides.cursor?.connected, true);
    assert.equal(b.events.some(e => e[0] === 'agent:sync'), false);
  });

  it('lets a new socket take over the same agentId and requests sync', () => {
    const first = fakeSocket('s1');
    const second = fakeSocket('s2');
    d.register(first, { agentId: 'agent-a', hostname: 'A' });
    d.register(second, { agentId: 'agent-a', hostname: 'A' });
    assert.equal(d.isActiveSocket(first), false);
    assert.equal(d.isActiveSocket(second), true);
    assert.equal(second.events.some(e => e[0] === 'agent:sync'), true);
    d.applyFull(first, { ...emptyCursorState(), agentActivityText: 'stale' });
    assert.equal(d.getState('agent-a')?.ides.cursor?.agentActivityText, undefined);
  });

  /**
   * `register()` warns on a takeover (console is its only side channel — there is no event), so the
   * tests below assert both the warning and the silence with one shared capture.
   */
  const captureWarn = (fn: () => void): string[] => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args.map(String).join(' '));
    };
    try {
      fn();
    }
    finally {
      console.warn = original;
    }
    return seen;
  };

  it('treats a reconnect (same instanceId) as the same process: state lands, the record survives', () => {
    const current = fakeSocket('s1');
    const reconnect = fakeSocket('s2');
    d.register(current, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'inst-1' });
    // A real displacement first, so there is a notice that the reconnect must not wipe.
    captureWarn(() => d.register(fakeSocket('s0'), { agentId: 'agent-a', hostname: 'A', version: '0.1.84', instanceId: 'inst-9' }));
    assert.equal(d.listMachines()[0].duplicateAgent?.socketId, 's1');

    const warnings = captureWarn(() => d.register(reconnect, { agentId: 'agent-a', hostname: 'A', version: '0.1.84', instanceId: 'inst-9' }));

    assert.deepEqual(warnings, []);
    assert.equal(d.isActiveSocket(reconnect), true);
    assert.equal(reconnect.events.some(e => e[0] === 'agent:sync'), true);
    assert.equal(reconnect.events.some(e => e[0] === 'agent:superseded'), false);
    // The new socket really feeds the machine state…
    d.applyFull(reconnect, { ...emptyCursorState(), agentActivityText: 'fresh' });
    assert.equal(d.getState('agent-a')?.ides.cursor?.agentActivityText, 'fresh');
    // …and the notice about the earlier displacement is still there.
    assert.equal(d.listMachines()[0].duplicateAgent?.socketId, 's1');
  });

  it('ignores an old-code newcomer while a process that names itself holds the slot', () => {
    const current = fakeSocket('s1');
    const old = fakeSocket('s2');
    d.register(current, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'inst-1' });
    const warnings = captureWarn(() => d.register(old, { agentId: 'agent-a', hostname: 'A', version: '0.0.0-dev' }));

    assert.equal(d.isActiveSocket(current), true);
    assert.equal(d.isActiveSocket(old), false);
    assert.equal(old.events.some(e => e[0] === 'agent:sync'), false);
    assert.equal(old.events.some(e => e[0] === 'agent:superseded'), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /ignored duplicate registration/);
    assert.match(warnings[0]!, /at=\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    // Its reports are dropped (it is not the active socket)…
    d.applyPatch(old, { ide: 'cursor', patch: { agentActivityText: 'from-the-ignored-one' } });
    assert.equal(d.getState('agent-a')?.ides.cursor?.agentActivityText, undefined);
    // …and nothing was displaced, so there is nothing to notice.
    assert.equal(d.listMachines()[0].duplicateAgent, undefined);
  });

  it('treats a blank instanceId as no identity, the way the agent side does', () => {
    const current = fakeSocket('s1');
    const blank = fakeSocket('s2');
    d.register(current, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'inst-1' });
    const warnings = captureWarn(() => d.register(blank, { agentId: 'agent-a', hostname: 'A', instanceId: '   ' }));

    // A blank id is not an identity on either side of the wire (`superseded-outcome.ts` trims too):
    // reading it as one here would hand the slot to a process the agent side refuses to stand down
    // for — the two ends would disagree about the same registration and flap.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /ignored duplicate registration/);
    assert.equal(d.isActiveSocket(current), true);
    assert.equal(d.isActiveSocket(blank), false);
    assert.equal(d.listMachines()[0].duplicateAgent, undefined);
  });

  it('promotes the ignored socket when the active one goes away, and keeps the next candidate', () => {
    const current = fakeSocket('s1');
    const first = fakeSocket('s2');
    const second = fakeSocket('s3');
    d.register(current, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'inst-1' });
    captureWarn(() => d.register(first, { agentId: 'agent-a', hostname: 'A' }));
    captureWarn(() => d.register(second, { agentId: 'agent-a', hostname: 'A' }));
    first.events.length = 0;

    captureWarn(() => d.onSocketDisconnect(current));

    // An old process never re-registers on its own: without promotion the machine would read offline
    // while a live agent is attached.
    assert.equal(d.isActiveSocket(first), true);
    assert.equal(first.events.some(e => e[0] === 'agent:sync'), true);
    assert.equal(d.listMachines()[0].connected, true);
    // The row must not keep claiming the version of the process that just left.
    assert.equal(d.listMachines()[0].cliVersion, undefined);
    d.applyFull(first, { ...emptyCursorState(), agentActivityText: 'from-the-first' });
    assert.equal(d.getState('agent-a')?.ides.cursor?.agentActivityText, 'from-the-first');

    // …and the second candidate is still remembered, so a machine whose first replacement also leaves
    // is not left dark.
    captureWarn(() => d.onSocketDisconnect(first));
    assert.equal(d.isActiveSocket(second), true);
    assert.equal(d.listMachines()[0].connected, true);
  });

  it('promotion clears the recorded identity, so the next old registration is a takeover', () => {
    const current = fakeSocket('s1');
    const promoted = fakeSocket('s2');
    d.register(current, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'inst-1' });
    captureWarn(() => d.register(promoted, { agentId: 'agent-a', hostname: 'A', version: '0.0.0-dev' }));
    captureWarn(() => d.onSocketDisconnect(current));
    assert.equal(d.isActiveSocket(promoted), true);

    // A different old process arrives. Had promotion left `instanceId = 'inst-1'` behind, this would be
    // judged `ignore-duplicate` (a process that names itself still holds the slot) and be dropped.
    const next = fakeSocket('s3');
    captureWarn(() => d.register(next, { agentId: 'agent-a', hostname: 'A', version: '0.0.0-dev' }));
    assert.equal(d.isActiveSocket(next), true);
    assert.equal(d.isActiveSocket(promoted), false);
    assert.equal(d.listMachines()[0].cliVersion, '0.0.0-dev');
  });

  it('warns on a takeover naming both identities, and records the displaced process', () => {
    const old = fakeSocket('s1');
    const current = fakeSocket('s2');
    // An unrelated machine: the event is a message to one socket, not a broadcast.
    const other = fakeSocket('s3');
    d.register(other, { agentId: 'agent-b', hostname: 'B', version: '0.1.83' });
    other.events.length = 0;
    d.register(old, { agentId: 'agent-a', hostname: 'A', version: '0.1.82' });
    const warnings = captureWarn(() => d.register(current, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'inst-2' }));

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /s1 → s2/);
    assert.match(warnings[0]!, /version 0\.1\.82 → 0\.1\.83/);
    assert.match(warnings[0]!, /instance none → inst-2/);
    assert.match(warnings[0]!, /at=\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    // Only the displaced socket is told, and the payload describes the winner…
    const superseded = old.events.find(e => e[0] === 'agent:superseded')?.[1][0] as
      | {
        reason?: string;
        by: { socketId: string; version?: string; hostname?: string; instanceId?: string };
        at: number;
      }
      | undefined;
    assert.equal(current.events.some(e => e[0] === 'agent:superseded'), false);
    // The event is a message to one socket: no other machine hears about it.
    assert.equal(other.events.some(e => e[0] === 'agent:superseded'), false);
    assert.equal(superseded?.reason, 'duplicate-agent');
    assert.equal(superseded?.by.socketId, 's2');
    assert.equal(superseded?.by.version, '0.1.83');
    assert.equal(superseded?.by.hostname, 'A');
    assert.equal(superseded?.by.instanceId, 'inst-2');
    // …and the record describes the loser, while the machine reports the winner.
    const row = d.listMachines().find(m => m.agentId === 'agent-a');
    assert.ok(row, 'the displaced machine is missing from the list');
    assert.equal(row.cliVersion, '0.1.83');
    assert.equal(row.duplicateAgent?.version, '0.1.82');
    assert.equal(row.duplicateAgent?.socketId, 's1');
  });

  it('records the displaced release version when a dev build wins the slot', () => {
    d.register(fakeSocket('s1'), { agentId: 'agent-a', hostname: 'A', version: '0.1.82' });
    captureWarn(() => d.register(fakeSocket('s2'), { agentId: 'agent-a', hostname: 'A', version: '0.0.0-dev', instanceId: 'dev-1' }));

    const row = d.listMachines()[0]!;
    assert.equal(row.cliVersion, '0.0.0-dev');
    assert.equal(row.duplicateAgent?.version, '0.1.82');
  });

  it('syncs on a first registration, so a fresh machine is not an empty shell', () => {
    const fresh = fakeSocket('s1');
    d.register(fresh, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'i1' });
    // The contract is "the agent is asked to re-report", not "exactly once": a second sync on this
    // path would be legitimate (and harmless) later.
    assert.ok(fresh.events.some(e => e[0] === 'agent:sync'));
  });

  it('promotion clears the record: the promoted process is the one reporting now', () => {
    const old = fakeSocket('s1');
    const winner = fakeSocket('s2');
    d.register(old, { agentId: 'agent-a', hostname: 'A', version: '0.1.80' });
    captureWarn(() => d.register(winner, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'i2' }));
    assert.equal(d.listMachines()[0].duplicateAgent?.socketId, 's1');

    captureWarn(() => d.onSocketDisconnect(winner));

    assert.equal(d.isActiveSocket(old), true);
    // v0.1.80 reports this row now, so "已顶替 v0.1.80" would name the very code that is running.
    assert.equal(d.listMachines()[0].duplicateAgent, undefined);
  });

  it('clears the record when the displaced socket disconnects, even though its mapping is gone', () => {
    const first = fakeSocket('s1');
    d.register(first, { agentId: 'agent-a', hostname: 'A', version: '0.1.82' });
    captureWarn(() => d.register(fakeSocket('s2'), { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'i2' }));
    assert.equal(d.listMachines()[0].duplicateAgent?.socketId, 's1');
    // register() removed the displaced socket's mapping: the clear must not depend on it.
    assert.equal(d.isActiveSocket(first), false);

    d.onSocketDisconnect(first);
    assert.equal(d.listMachines()[0].duplicateAgent, undefined);
  });

  it('overwrites the record on the next takeover, and hands the slot on until the machine is dark', () => {
    const first = fakeSocket('s1');
    const second = fakeSocket('s2');
    d.register(first, { agentId: 'agent-a', hostname: 'A', version: '0.1.82' });
    captureWarn(() => d.register(second, { agentId: 'agent-a', hostname: 'A', version: '0.1.83', instanceId: 'i2' }));
    const third = fakeSocket('s3');
    captureWarn(() => d.register(third, { agentId: 'agent-a', hostname: 'A', version: '0.1.84', instanceId: 'i3' }));
    assert.equal(d.listMachines()[0].duplicateAgent?.socketId, 's2');

    // The displaced sockets are still connected, so the machine is handed over rather than going dark;
    // the promotion takes the earliest remembered candidate (deterministic, see design.md).
    d.onSocketDisconnect(third);
    assert.equal(d.isActiveSocket(first), true);
    // The record names `s2`, which is still connected and still being dropped: promoting `s1` must not
    // hide that.
    assert.equal(d.listMachines()[0].duplicateAgent?.socketId, 's2');
    d.onSocketDisconnect(first);
    assert.equal(d.isActiveSocket(second), true);
    // Now the promoted socket *is* the recorded one, so the notice would name the reporter: cleared.
    assert.equal(d.listMachines()[0].duplicateAgent, undefined);
    // Only once nobody is left does "delete this machine" become possible — and then it really clears.
    assert.equal(d.forget('agent-a'), false);
    d.onSocketDisconnect(second);
    assert.equal(d.forget('agent-a'), true);
    assert.equal(d.listMachines().find(m => m.agentId === 'agent-a'), undefined);
  });

  it('shows a machine only to its owner', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'A', owner: 'alice' });
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'B', owner: 'bob' });
    // Unowned machines (the registry API allows this; the enroll path cannot produce it): appear for nobody
    d.register(fakeSocket('sc'), { agentId: 'agent-c', hostname: 'C' });

    assert.deepEqual(d.listMachines('alice').map(m => m.agentId), ['agent-a']);
    assert.deepEqual(d.listMachines('bob').map(m => m.agentId), ['agent-b']);
    assert.deepEqual(d.listMachines('carol'), []);
    assert.equal(d.listMachines('alice')[0].owner, 'alice');
    // Omitting userId = no isolation (local mode / probes / other internal callers)
    assert.equal(d.listMachines().length, 3);

    assert.equal(d.hasAgent('alice'), true);
    assert.equal(d.hasAgent('carol'), false);
    assert.equal(d.hasAgent(), true);
  });

  it('persists the owner for an offline machine, and refuses to hand it to another owner', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A', owner: 'alice' });
    d.onSocketDisconnect(a);
    const reloaded = new AgentDirectory(newStore(), {
      persistDebounceMs: 0,
    });
    assert.deepEqual(reloaded.listMachines('alice').map(m => m.agentId), ['agent-a']);

    // Someone else registers with the same id: reject; ownership and the list stay put (used to reassign the machine to them)
    assert.equal(
      reloaded.register(fakeSocket('sb'), { agentId: 'agent-a', hostname: 'A', owner: 'bob' }),
      null,
    );
    assert.deepEqual(reloaded.listMachines('alice').map(m => m.agentId), ['agent-a']);
    assert.deepEqual(reloaded.listMachines('bob'), []);

    // A legacy register with no owner cannot bump an owned row either (unrecognised owner = not theirs)
    assert.equal(reloaded.register(fakeSocket('sc'), { agentId: 'agent-a', hostname: 'A' }), null);
    assert.deepEqual(reloaded.listMachines('alice').map(m => m.agentId), ['agent-a']);
  });

  it('adopts the legacy hostname-derived id when the same machine re-enrolls with a new id', () => {
    const legacy = fakeSocket('s-legacy');
    d.register(legacy, { agentId: 'agent-MBP', hostname: 'MBP', owner: 'alice', version: '0.1.61' });
    d.applyFull(legacy, { ides: { cursor: { ...emptyCursorState(), connected: true } } });
    d.applySessionsIndex(legacy, { sessions: [sessionMeta('s1')] });
    d.applySessionFull(legacy, { sessionId: 's1', ide: 'codebuddy', messages: [human('h1')] });
    d.onSocketDisconnect(legacy);

    const fresh = fakeSocket('s-fresh');
    assert.equal(
      d.register(fresh, { agentId: 'machine-xyz', hostname: 'MBP', owner: 'alice' }),
      'machine-xyz',
    );

    // The list always has one row: old id disappears; snapshot / ledger / body follow the new id
    assert.deepEqual(d.listMachines('alice').map(m => m.agentId), ['machine-xyz']);
    assert.equal(d.getState('machine-xyz')?.ides.cursor?.connected, true, '快照跟着改签');
    assert.deepEqual(sessionStore.findSessionOwners('s1', 'codebuddy'), ['machine-xyz']);
    assert.equal(sessionStore.readSession('machine-xyz', 's1', 'codebuddy')?.length, 1, '正文跟着搬');

    // After restart the old row must not come back to life
    const reloaded = new AgentDirectory(newStore(), {
      persistDebounceMs: 0,
      sessionStore,
    });
    assert.deepEqual(reloaded.listMachines('alice').map(m => m.agentId), ['machine-xyz']);
  });

  it('does not adopt a live machine that shares the hostname', () => {
    const first = fakeSocket('s1');
    d.register(first, { agentId: 'machine-1', hostname: 'MBP', owner: 'alice' });
    d.register(fakeSocket('s2'), { agentId: 'machine-2', hostname: 'MBP', owner: 'alice' });
    assert.equal(d.isActiveSocket(first), true, '在线的那台不许被改签掉');
    assert.deepEqual(d.listMachines('alice').map(m => m.agentId).sort(), ['machine-1', 'machine-2']);
  });

  it('does not adopt when two offline machines share the hostname', () => {
    const first = fakeSocket('s1');
    const second = fakeSocket('s2');
    d.register(first, { agentId: 'machine-1', hostname: 'dev', owner: 'alice' });
    d.register(second, { agentId: 'machine-2', hostname: 'dev', owner: 'alice' });
    d.onSocketDisconnect(first);
    d.onSocketDisconnect(second);

    // Both offline, same name: cannot tell them apart → keep each; a third machine is created as usual
    d.register(fakeSocket('s3'), { agentId: 'machine-3', hostname: 'dev', owner: 'alice' });
    assert.deepEqual(d.listMachines('alice').map(m => m.agentId).sort(), [
      'machine-1',
      'machine-2',
      'machine-3',
    ]);
  });

  it('only accepts a command result from the machine the command went to', () => {
    const a = fakeSocket('sa');
    const b = fakeSocket('sb');
    const browser = fakeSocket('br');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.register(b, { agentId: 'agent-b', hostname: 'B' });
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c1', type: 'new_chat' }, browser);

    // B answers for A: drop it; pending stays with A (otherwise the requester never gets the real result)
    d.routeResult({ commandId: 'c1', ok: false, error: 'spoofed' } as CommandResult, 'agent-b');
    assert.deepEqual(browser.events, []);

    d.routeResult({ commandId: 'c1', ok: true } as CommandResult, 'agent-a');
    assert.deepEqual(browser.events, [['command:result', [{ commandId: 'c1', ok: true }]]]);
  });

  it('never adopts across owners, even with the same hostname', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-MBP', hostname: 'MBP', owner: 'alice' });
    d.onSocketDisconnect(a);
    d.register(fakeSocket('sb'), { agentId: 'machine-bob', hostname: 'MBP', owner: 'bob' });
    assert.deepEqual(d.listMachines('alice').map(m => m.agentId), ['agent-MBP']);
    assert.deepEqual(d.listMachines('bob').map(m => m.agentId), ['machine-bob']);
  });

  it('stops persisting after dispose, so a shutdown can close the DB safely', async () => {
    // On shutdown the agent just sent a patch: that debounce timer wakes after DB close.
    // Against a JSON file that is a no-op write; against SQLite it throws "database connection is not open".
    const localStore = newStore();
    const debounced = new AgentDirectory(localStore, { persistDebounceMs: 30, sessionStore });
    const a = fakeSocket('sa');
    debounced.register(a, { agentId: 'agent-a', hostname: 'A', owner: 'alice' });
    debounced.applyPatch(a, { agentStatus: 'generating' });
    debounced.dispose();
    localStore.close();

    await new Promise(r => setTimeout(r, 80));
    assert.deepEqual(debounced.listMachines('alice').map(m => m.agentId), ['agent-a']);
  });

  it('reloads offline machines from the store', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'mbp' });
    d.applyFull(a, { ...emptyCursorState(), connected: true });
    d.onSocketDisconnect(a);
    const d2 = new AgentDirectory(newStore(), {
      persistDebounceMs: 0,
    });
    assert.equal(d2.listMachines()[0].connected, false);
    assert.equal(d2.getState('agent-a')?.ides.cursor?.connected, true);
    assert.equal(d2.hasAgent(), false);
  });

  it('rejects commands to an offline machine', () => {
    const browser = fakeSocket('br');
    d.sendCommand('missing', 'command:new_chat', { commandId: 'c1', type: 'new_chat' }, browser);
    assert.deepEqual(browser.events[0], [
      'command:result',
      [{ commandId: 'c1', ok: false, error: 'Machine offline' }],
    ]);
  });

  it('fails in-flight commands when a new socket takes over', () => {
    const first = fakeSocket('s1');
    const second = fakeSocket('s2');
    const browser = fakeSocket('br');
    d.register(first, { agentId: 'agent-a', hostname: 'A' });
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c1', type: 'new_chat' }, browser);
    d.register(second, { agentId: 'agent-a', hostname: 'A' });
    assert.deepEqual(browser.events.find(e => e[0] === 'command:result'), [
      'command:result',
      [{ commandId: 'c1', ok: false, error: 'Agent disconnected' }],
    ]);
  });

  it('forgets an offline machine from memory and the store', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'B' });
    a.connected = false;
    d.onSocketDisconnect(a);
    assert.equal(d.forget('agent-a'), true);
    const list = d.listMachines();
    assert.equal(list.length, 1);
    assert.equal(list[0].agentId, 'agent-b');
    const d2 = new AgentDirectory(newStore(), {
      persistDebounceMs: 0,
    });
    assert.equal(d2.listMachines().some(m => m.agentId === 'agent-a'), false);
    assert.equal(d2.listMachines().some(m => m.agentId === 'agent-b'), true);
  });

  it('drops the session mirror when the machine is deleted', () => {
    const remote = fakeSocket('sr');
    d.register(remote, { agentId: 'agent-r', hostname: 'R', owner: 'alice' });
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    d.applySessionFull(remote, { sessionId: 's1', ide: 'codebuddy', messages: [human('h1')] });
    assert.equal(d.forget('agent-r'), false, '在线删不掉');

    remote.connected = false;
    d.onSocketDisconnect(remote);
    assert.equal(d.forget('agent-r'), true);

    // Clear the machine row and session mirror together: ledger and body must not remain
    assert.deepEqual(sessionStore.readIndex('agent-r'), []);
    assert.equal(sessionStore.readSession('agent-r', 's1', 'codebuddy'), null);
    assert.deepEqual(sessionStore.findSessionOwners('s1', 'codebuddy'), []);

    // Same id re-enrolls (daemon still running): the machine comes back, but old sessions are not "resurrected"
    d.register(fakeSocket('sr2'), { agentId: 'agent-r', hostname: 'R', owner: 'alice' });
    assert.equal(
      d.listMachines('alice').find(m => m.agentId === 'agent-r')?.contentIdes,
      undefined,
    );
  });

  it('refuses to forget a connected machine', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'A' });
    assert.equal(d.forget('agent-a'), false);
    assert.equal(d.listMachines().length, 1);
    assert.equal(d.listMachines()[0].connected, true);
  });

  it('treats forgetting an unknown id as success', () => {
    assert.equal(d.forget('nope'), true);
    assert.deepEqual(d.listMachines(), []);
  });

  it('drops messages from inbound state:full and state:patch', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.applyFull(a, {
      ...emptyCursorState(),
      messages: [{ type: 'human', id: 'h1', flatIndex: 0, text: 'nope', mentions: [] }],
    });
    assert.equal(d.getState('agent-a')?.ides.cursor?.messages.length, 0);
    d.applyPatch(a, {
      messages: [{ type: 'human', id: 'h2', flatIndex: 1, text: 'still-nope', mentions: [] }],
    });
    assert.equal(d.getState('agent-a')?.ides.cursor?.messages.length, 0);
  });

  it('listMachines carries a per-ide summary for the rail sub-rows', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.applyFull(a, {
      ides: {
        cursor: { ...emptyCursorState(), connected: true, pendingApprovals: [{ id: 'ap1' } as never] },
        codebuddy: { ...emptyCursorState(), connected: false },
      },
    });
    const row = d.listMachines()[0];
    assert.deepEqual(row.ides, {
      cursor: { connected: true, pendingApprovals: 1 },
      codebuddy: { connected: false, pendingApprovals: 0 },
    });
  });

  it('emits machines:changed only when an ide status actually changes', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.applyFull(a, { ides: { cursor: emptyCursorState() } });
    let changes = 0;
    d.on('machines:changed', () => { changes += 1; });

    d.applyPatch(a, { ide: 'cursor', patch: { agentStatus: 'generating' } });
    assert.equal(changes, 0, '普通活态 patch 不该刷名单');

    d.applyPatch(a, { ide: 'cursor', patch: { connected: true } });
    assert.equal(changes, 1, 'IDE 上线要刷名单');

    d.applyPatch(a, { ide: 'cursor', patch: { pendingApprovals: [{ id: 'ap1' } as never] } });
    assert.equal(changes, 2, '审批数变化也要刷名单');
  });

  // The rail row of a **non-selected** machine reads `host` from machines:list,
  // and host is learned on connect — a patch that moves nothing else.
  it('refreshes the machine list when only the host changes', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.applyFull(a, { ides: { cursor: emptyCursorState() } });
    let changes = 0;
    d.on('machines:changed', () => { changes += 1; });

    d.applyPatch(a, { ide: 'cursor', patch: { host: 'vscode' } });
    assert.equal(changes, 1, '宿主标签变了也要刷名单');
    assert.equal(d.getState('agent-a')?.ides.cursor?.host, 'vscode');
  });

  it('applyPatch with ide only updates that slot', () => {
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.applyFull(a, {
      ides: { cursor: emptyCursorState(), codebuddy: emptyCursorState() },
    });
    d.applyPatch(a, { ide: 'codebuddy', patch: { agentStatus: 'generating' } });
    assert.equal(d.getState('agent-a')?.ides.codebuddy?.agentStatus, 'generating');
    assert.equal(d.getState('agent-a')?.ides.cursor?.agentStatus, 'idle');
  });

  it('answers session:get from the content machine store (IDE and data on different machines)', () => {
    const mac = fakeSocket('s-mac');
    const remote = fakeSocket('s-remote');
    const browser = fakeSocket('br');
    d.register(mac, { agentId: 'agent-mac', hostname: 'MBP' });
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });

    // Remote dev machine: report census + push body
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    d.applySessionFull(remote, { sessionId: 's1', ide: 'codebuddy', messages: [human('h1')] });

    // Web selects the Mac and opens s1: if the DB has it, answer directly and do not bother any agent
    d.handleSessionGet('agent-mac', { sessionId: 's1', ide: 'codebuddy' }, browser);

    const reply = browser.events.find(e => e[0] === 'session:full');
    assert.ok(reply, 'should reply session:full from the owner store');
    assert.equal((reply[1][0] as { sessionId: string }).sessionId, 's1');
    assert.equal(mac.events.some(e => e[0] === 'session:get'), false, '不问没有这条内容的 IDE 机');
    assert.equal(remote.events.some(e => e[0] === 'session:get'), true, '库命中也要回源刷新一次');
  });

  it('rate-limits the store-hit refresh to once a minute per session', () => {
    let now = 1000;
    const dd = new AgentDirectory(store, { persistDebounceMs: 0, now: () => now, sessionStore });
    const remote = fakeSocket('s-remote');
    const browser = fakeSocket('br');
    dd.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    dd.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    dd.applySessionFull(remote, { sessionId: 's1', ide: 'codebuddy', messages: [human('h1')] });
    remote.events.length = 0;
    const pokes = () => remote.events.filter(e => e[0] === 'session:get').length;

    dd.handleSessionGet('agent-mac', { sessionId: 's1', ide: 'codebuddy' }, browser);
    assert.equal(pokes(), 1, '第一次命中库后补刷新');
    dd.handleSessionGet('agent-mac', { sessionId: 's1', ide: 'codebuddy' }, browser);
    assert.equal(pokes(), 1, '冷却期内不重复刷新');

    now += 61_000;
    dd.handleSessionGet('agent-mac', { sessionId: 's1', ide: 'codebuddy' }, browser);
    assert.equal(pokes(), 2, '冷却过了再补一次');
  });

  it('drops an empty full from a machine that does not own the session', () => {
    const mac = fakeSocket('s-mac');
    const remote = fakeSocket('s-remote');
    d.register(mac, { agentId: 'agent-mac', hostname: 'MBP' });
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    d.applySessionFull(remote, { sessionId: 's1', ide: 'codebuddy', messages: [human('h1')] });

    const emitted: Array<[string, unknown]> = [];
    d.on('session:full', (agentId: string, payload: unknown) => emitted.push([agentId, payload]));

    // An IDE machine asked for a session it does not have locally answers empty: that packet must
    // not be broadcast and must not be persisted on its behalf, or the body the content machine
    // pushed would be wiped on the web.
    d.applySessionFull(mac, { sessionId: 's1', ide: 'codebuddy', messages: [] });
    assert.equal(emitted.length, 0, '非 owner 的空正文不广播');
    assert.equal(sessionStore.readSession('agent-mac', 's1', 'codebuddy')?.length ?? 0, 0, '不替它落库');
    assert.equal(sessionStore.readSession('agent-r', 's1', 'codebuddy')?.length, 1, '内容机的正文还在');

    // The owner's own empty body is accepted: an empty session is a legal state; resetting the baseline is its right.
    d.applySessionsIndex(remote, {
      mode: 'delta',
      sessions: [sessionMeta('s2')],
      reportedIdes: ['codebuddy'],
    });
    d.applySessionFull(remote, { sessionId: 's2', ide: 'codebuddy', messages: [] });
    assert.equal(emitted.length, 1, 'owner 的空正文要广播');
    assert.equal(emitted[0][0], 'agent-r');
  });

  it('waits for the ledger instead of broadcasting, then asks only the content machine', () => {
    const mac = fakeSocket('s-mac');
    const remote = fakeSocket('s-remote');
    const other = fakeSocket('s-other');
    const browser = fakeSocket('br');
    d.register(mac, { agentId: 'agent-mac', hostname: 'MBP' });
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    d.register(other, { agentId: 'agent-x', hostname: 'other' });

    d.handleSessionGet('agent-mac', { sessionId: 's1', ide: 'codebuddy' }, browser);
    assert.equal(browser.events.some(e => e[0] === 'session:full'), false, '账本没有 → 先等');
    assert.equal(remote.events.some(e => e[0] === 'session:get'), false, '不乱点名');
    assert.equal(other.events.some(e => e[0] === 'session:get'), false, '绝不广播');
    assert.equal(mac.events.some(e => e[0] === 'session:get'), true, '本机 agent 照旧问一次');

    // The content machine then reports census: poke only it
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    assert.equal(remote.events.some(e => e[0] === 'session:get'), true, '点名内容机器');
    assert.equal(other.events.some(e => e[0] === 'session:get'), false);
  });

  it('merges a delta index report and drops removed sessions from the ledger', () => {
    const remote = fakeSocket('s-remote');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });

    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1'), sessionMeta('s2')] });
    assert.deepEqual(sessionStore.findSessionOwners('s1', 'codebuddy'), ['agent-r']);
    assert.deepEqual(sessionStore.findSessionOwners('s2', 'codebuddy'), ['agent-r']);

    d.applySessionsIndex(remote, {
      mode: 'delta',
      sessions: [sessionMeta('s2'), sessionMeta('s3')],
      removed: [{ ide: 'codebuddy', sessionId: 's1' }],
    });
    assert.deepEqual(sessionStore.findSessionOwners('s1', 'codebuddy'), [], 's1 已从盘上删除');
    assert.deepEqual(sessionStore.findSessionOwners('s2', 'codebuddy'), ['agent-r']);
    assert.deepEqual(sessionStore.findSessionOwners('s3', 'codebuddy'), ['agent-r']);
  });

  it('marks a content-only machine and clears the flag once an IDE connects', () => {
    const remote = fakeSocket('s-remote');
    const mac = fakeSocket('s-mac');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    d.register(mac, { agentId: 'agent-mac', hostname: 'MBP' });
    d.applyFull(mac, { ides: { cursor: { ...emptyCursorState(), connected: true } } });

    // Remote: reported census (has content), no IDE live state → content source
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    let rows = d.listMachines();
    const remoteRow = rows.find(m => m.agentId === 'agent-r')!;
    assert.deepEqual(remoteRow.contentIdes, ['codebuddy']);
    assert.equal(remoteRow.contentOnly, true);
    assert.equal(rows.find(m => m.agentId === 'agent-mac')!.contentOnly, undefined, '有活态的不算纯内容机');

    // The day this remote also has live state (GUI installed) → no longer a pure content machine
    d.applyFull(remote, { ides: { codebuddy: { ...emptyCursorState(), connected: true } } });
    rows = d.listMachines();
    assert.equal(rows.find(m => m.agentId === 'agent-r')!.contentOnly, false);
  });

  it('keeps a GUI machine out of contentOnly when CDP is down but liveIdes is set', () => {
    const mac = fakeSocket('s-mac');
    d.register(mac, { agentId: 'agent-mac', hostname: 'MBP', liveIdes: ['cursor'] });
    d.applySessionsIndex(mac, { sessions: [sessionMeta('s1')] });
    d.applyPatch(mac, { ide: 'cursor', patch: {
      cdpIssue: { kind: 'no-window', scope: 'workbench', cdpUrl: 'http://127.0.0.1:9222', port: 9222, detail: '', at: 1 },
    } });
    assert.equal(d.listMachines().find(m => m.agentId === 'agent-mac')!.contentOnly, false);
    assert.equal(
      d.getStateOrEmpty('agent-mac').ides.codebuddy,
      undefined,
      '装了 GUI 的机器即使 CDP 挂了也不投影成内容源',
    );
  });

  it('uses contentSource (not the app-path list) to decide content-only', () => {
    // "App not on the inventory" is not "this machine is only a data source": Setapp / Homebrew
    // custom-dir installs have empty liveIdes but are clearly controllable, and must not be
    // folded into "content source" (review R1).
    const gui = fakeSocket('s-gui');
    d.register(gui, { agentId: 'agent-gui', hostname: 'MBP', liveIdes: [], contentSource: false });
    d.applySessionsIndex(gui, { sessions: [sessionMeta('s1')] });
    assert.equal(
      d.listMachines().find(m => m.agentId === 'agent-gui')!.contentOnly,
      false,
      'liveIdes 空但机器能控制：不能收进内容源',
    );

    const linux = fakeSocket('s-hl');
    d.register(linux, { agentId: 'agent-hl', hostname: 'sandbox', liveIdes: [], contentSource: true });
    d.applySessionsIndex(linux, { sessions: [sessionMeta('s1')] });
    assert.equal(
      d.listMachines().find(m => m.agentId === 'agent-hl')!.contentOnly,
      true,
      'Linux（只做数据源）：仍然是内容源',
    );
  });

  it('applyConnection is per-ide; legacy agents without ide fall back to the cursor slot', () => {
    // P4: connection:status payload has optional ide. New agents write the matching slot;
    // old machines (agent ≤0.1.72) omit it → fall back to cursor, byte-identical to old production.
    const a = fakeSocket('sa');
    d.register(a, { agentId: 'agent-a', hostname: 'A' });
    d.applyFull(a, { ides: { cursor: emptyCursorState(), codebuddy: emptyCursorState() } });

    d.applyConnection(a, { ide: 'codebuddy', connected: true });
    assert.equal(d.getState('agent-a')?.ides.codebuddy?.connected, true, '带 ide 写对应槽');
    assert.equal(d.getState('agent-a')?.ides.cursor?.connected, false, '不误伤别的槽');

    d.applyConnection(a, { connected: true });
    assert.equal(d.getState('agent-a')?.ides.cursor?.connected, true, '老 agent 不带 ide 回落 cursor 槽');
  });

  it('keeps a remote machine contentOnly even if cdpIssue is set when liveIdes is empty', () => {
    const remote = fakeSocket('s-r');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox', liveIdes: [] });
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    d.applyPatch(remote, { ide: 'cursor', patch: {
      cdpIssue: { kind: 'no-listener', scope: 'workbench', cdpUrl: 'http://127.0.0.1:9222', port: 9222, detail: '', at: 1 },
    } });
    assert.equal(d.listMachines().find(m => m.agentId === 'agent-r')!.contentOnly, true);
  });

  it('keeps cdpIssue on the content-only outwardState projection', () => {
    const remote = fakeSocket('s-r-issue');
    d.register(remote, { agentId: 'agent-issue', hostname: 'sandbox', liveIdes: [] });
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    const issue = {
      kind: 'no-listener' as const,
      scope: 'workbench' as const,
      cdpUrl: 'http://127.0.0.1:9222',
      port: 9222,
      detail: 'ECONNREFUSED',
      at: 1,
    };
    d.applyPatch(remote, { ide: 'codebuddy', patch: { cdpIssue: issue, liveIssue: issue } });
    const projected = d.getStateOrEmpty('agent-issue').ides.codebuddy;
    assert.deepEqual(projected?.cdpIssue, issue);
    assert.deepEqual(projected?.liveIssue, issue);
    assert.equal(projected?.inputAvailable, false);
  });

  it('restores the content-source flag from the ledger after a restart', () => {
    const remote = fakeSocket('s-remote');
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });

    // Simulate a server restart: in-memory contentIdes is gone, but the ledger (same sessions.sqlite) remains.
    // Census is only re-sent when the fingerprint changes; without this step "content sources" stay empty.
    const d2 = new AgentDirectory(store, { persistDebounceMs: 0, now: () => 50, sessionStore });
    const restored = d2.listMachines().find(m => m.agentId === 'agent-r')!;
    assert.deepEqual(restored.contentIdes, ['codebuddy'], '重启时按总账恢复');
    assert.equal(restored.contentOnly, true);

    // Reconnect (agent process did not restart, fingerprint unchanged, no re-census) is the same
    d2.register(fakeSocket('s-remote-2'), { agentId: 'agent-r', hostname: 'sandbox' });
    assert.deepEqual(
      d2.listMachines().find(m => m.agentId === 'agent-r')!.contentIdes,
      ['codebuddy'],
    );
  });

  it('relays the content machine\'s full/append to the machine whose web asked for it', () => {
    const mac = fakeSocket('s-mac');
    const remote = fakeSocket('s-remote');
    const browser = fakeSocket('br');
    d.register(mac, { agentId: 'agent-mac', hostname: 'MBP' });
    d.register(remote, { agentId: 'agent-r', hostname: 'sandbox' });
    d.applySessionsIndex(remote, { sessions: [sessionMeta('s1')] });
    d.applySessionFull(remote, { sessionId: 's1', ide: 'codebuddy', messages: [human('h1')] });
    d.handleSessionGet('agent-mac', { sessionId: 's1', ide: 'codebuddy' }, browser);

    const relayed: Array<[string, unknown]> = [];
    d.on('session:append', (agentId: string, payload: unknown) => relayed.push([agentId, payload]));

    d.applySessionAppend(remote, {
      sessionId: 's1',
      ide: 'codebuddy',
      messages: [{ type: 'assistant', id: 'a1', flatIndex: 1, text: 'more' } as ChatElement],
    });

    const toMac = relayed.find(([agentId]) => agentId === 'agent-mac');
    assert.ok(toMac, '增量要转给请求方机器（网页在 Mac 视图下看）');
    assert.equal((toMac[1] as { sessionId: string }).sessionId, 's1');
    assert.equal(relayed.some(([agentId]) => agentId === 'agent-r'), true, '内容机器原有广播保留');
  });

  it('projects a content-only machine ledger into read-only tabs (web session list)', () => {
    const remote = fakeSocket('sr');
    d.register(remote, { agentId: 'agent-r', hostname: 'R' });
    d.applySessionsIndex(remote, {
      sessions: [
        { ...sessionMeta('s-old'), lastUpdatedAt: 100 },
        { ...sessionMeta('s-new'), lastUpdatedAt: 200 },
        { ...sessionMeta('s-sub'), lastUpdatedAt: 300, isSubagent: true },
      ],
      reportedIdes: ['codebuddy'],
    });

    const state = d.getStateOrEmpty('agent-r');
    const tabs = state.ides.codebuddy?.chatTabs ?? [];
    // Most recent first; subagents stay out of the list
    assert.deepEqual(tabs.map(t => t.composerId), ['s-new', 's-old']);
    assert.equal(state.ides.codebuddy?.activeComposerId, 's-new', '默认打开最近一个');
    assert.equal(state.ides.codebuddy?.inputAvailable, false, '只读：不接受输入');
    assert.deepEqual(state.ides.codebuddy?.windows.map(w => w.id), ['content:codebuddy']);
  });

  it('keeps a machine with a live IDE untouched (no injected read-only tabs)', () => {
    const mac = fakeSocket('sm');
    d.register(mac, { agentId: 'agent-mac', hostname: 'M' });
    d.applyFull(mac, { ...emptyCursorState(), connected: true });
    d.applySessionsIndex(mac, { sessions: [sessionMeta('s1')], reportedIdes: ['codebuddy'] });
    const state = d.getStateOrEmpty('agent-mac');
    assert.equal(state.ides.codebuddy, undefined, '有活态的机器不注入只读 tabs');
  });

  it('reorders the machine list and the order survives a restart', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'A' });
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'B' });
    d.register(fakeSocket('sc'), { agentId: 'agent-c', hostname: 'C' });
    assert.deepEqual(d.listMachines().map(m => m.agentId), ['agent-a', 'agent-b', 'agent-c'], '默认 = 注册顺序');

    assert.equal(d.reorderMachines(['agent-c', 'agent-a', 'agent-b']), true);
    assert.deepEqual(d.listMachines().map(m => m.agentId), ['agent-c', 'agent-a', 'agent-b']);

    // Server restart: the order comes back from the machines table
    const reloaded = new AgentDirectory(store, { persistDebounceMs: 0, now: () => 60, sessionStore });
    assert.deepEqual(reloaded.listMachines().map(m => m.agentId), ['agent-c', 'agent-a', 'agent-b']);
  });

  it('appends a machine enrolled after a reorder at the end', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'A' });
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'B' });
    assert.equal(d.reorderMachines(['agent-b', 'agent-a']), true);

    d.register(fakeSocket('sc'), { agentId: 'agent-c', hostname: 'C' });
    assert.deepEqual(d.listMachines().map(m => m.agentId), ['agent-b', 'agent-a', 'agent-c'], '新机器不打扰已排好的顺序');
  });

  it('refuses an order that names an unknown machine and changes nothing', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'A' });
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'B' });

    assert.equal(d.reorderMachines(['agent-b', 'agent-zzz']), false);
    assert.deepEqual(d.listMachines().map(m => m.agentId), ['agent-a', 'agent-b']);
  });

  it('refuses an order that names the same machine twice', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'A' });
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'B' });

    assert.equal(d.reorderMachines(['agent-a', 'agent-a']), false, '重复 id 会导致一行被写两次，目录层自己就该拒绝');
    assert.deepEqual(d.listMachines().map(m => m.agentId), ['agent-a', 'agent-b']);
  });

  it('keeps never-reordered machines in registration order even when others have an order', () => {
    d.register(fakeSocket('sa'), { agentId: 'agent-a', hostname: 'A' });
    d.register(fakeSocket('sb'), { agentId: 'agent-b', hostname: 'B' });
    assert.equal(d.reorderMachines(['agent-b']), true);
    assert.deepEqual(d.listMachines().map(m => m.agentId), ['agent-b', 'agent-a'], '手动排过的在前，没排过的按注册顺序殿后');
  });
});

describe('normalizeMachineName', () => {
  it('trims, collapses whitespace and strips control characters', () => {
    assert.equal(normalizeMachineName('  客厅的 Mac   mini '), '客厅的 Mac mini');
    assert.equal(normalizeMachineName('a\u0000b\nc'), 'a b c');
    assert.equal(normalizeMachineName('dev\tbox'), 'dev box');
  });

  it('treats a blank name as "clear the alias"', () => {
    assert.equal(normalizeMachineName(''), null);
    assert.equal(normalizeMachineName('   \n\t '), null);
  });

  it('caps the length by code point (never splits a surrogate pair)', () => {
    assert.equal(Array.from(normalizeMachineName('机'.repeat(40)) ?? '').length, MACHINE_NAME_MAX_LENGTH);
    assert.equal(normalizeMachineName('🙂'.repeat(30)), '🙂'.repeat(MACHINE_NAME_MAX_LENGTH));
    assert.equal(normalizeMachineName('短名'), '短名');
  });
});
