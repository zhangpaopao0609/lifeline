import type { CliAcpCapability } from '../packages/protocol/src/index.js';
import type { AgentSocket } from '../packages/server/src/agent-hub.js';
import type { SessionStore } from '../packages/server/src/session-store.js';
import type { CommandPayload, CommandResult } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { staticCliAcp } from '../packages/agent/src/cli-capability.js';
import { ALL_COMMAND_EVENTS } from '../packages/protocol/src/index.js';
import {
  AgentDirectory,
  CLI_INBOUND_LOG_MAX_CHARS,
  CLI_SYNC_COOLDOWN_MS,
} from '../packages/server/src/agent-hub.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';
import {
  bindCliViewer,
  browserCommandEventNames,
  resolveCliSyncRequest,
} from '../packages/server/src/relay.js';
import { SessionStore as SessionStoreClass } from '../packages/server/src/session-store.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

const cursorCli: CliAcpCapability = {
  protocolVersion: 1,
  platform: 'darwin',
  sources: [{ source: 'cursor-cli' }],
};

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

function named(events: Array<[string, unknown[]]>, event: string): unknown[][] {
  return events.filter(entry => entry[0] === event).map(entry => entry[1]);
}

function appendPayload(overrides: Record<string, unknown> = {}) {
  return {
    epoch: EPOCH,
    source: 'cursor-cli',
    sessionId: SESSION_ID,
    seq: 1,
    messages: [{ id: 'm1', type: 'human', flatIndex: 0, text: 'hi' }],
    ...overrides,
  };
}

function snapshotPayload() {
  return {
    epoch: EPOCH,
    snapshotId: SNAPSHOT_ID,
    sessions: [{
      source: 'cursor-cli',
      sessionId: SESSION_ID,
      cwd: '/tmp/work',
      status: 'idle',
      seq: 0,
      approvals: [],
    }],
  };
}

function captureWarn(fn: () => void): string[] {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(' '));
  };
  try {
    fn();
  }
  finally {
    console.warn = orig;
  }
  return seen;
}

const STORE_METHODS = [
  'writeIndex',
  'mergeIndex',
  'writeSession',
  'appendSession',
  'appendMessages',
  'readSession',
  'readIndex',
  'readSessionSeq',
  'readSessionPage',
  'dropAgent',
  'moveAgent',
  'findSessionOwners',
] as const;

function watchStore(store: SessionStore): string[] {
  const calls: string[] = [];
  for (const name of STORE_METHODS) {
    const orig = store[name];
    store[name] = ((...args: unknown[]) => {
      calls.push(name);
      return (orig as (...inner: unknown[]) => unknown).apply(store, args);
    }) as typeof orig;
  }
  return calls;
}

function holdQueue() {
  const pending: Array<() => void> = [];
  return {
    hold(): Promise<void> {
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
    release() {
      pending.shift()?.();
    },
  };
}

describe('AgentDirectory CLI forwarding', () => {
  let dir: string;
  let store: IdentityStore;
  let sessionStore: SessionStore;
  let now: number;
  let d: AgentDirectory;
  const stores: IdentityStore[] = [];

  const newStore = (name = 'identity.sqlite'): IdentityStore => {
    const created = new IdentityStore(join(dir, name));
    stores.push(created);
    return created;
  };

  function directory(options?: { cliSyncCooldownMs?: number; pendingTtlMs?: number }): AgentDirectory {
    return new AgentDirectory(store, {
      persistDebounceMs: 0,
      now: () => now,
      sessionStore,
      ...options,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-cli-'));
    now = 50;
    store = newStore();
    sessionStore = new SessionStoreClass(join(dir, 'sessions.sqlite'));
    d = directory();
  });

  afterEach(() => {
    d.dispose();
    sessionStore.close();
    for (const item of stores) {
      try {
        item.close();
      }
      catch {
        /* already closed */
      }
    }
    stores.length = 0;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('drops cli events from an agent that never declared cliAcp', () => {
    const agent = fakeSocket('old');
    const viewer = fakeSocket('viewer');
    d.register(agent, { agentId: 'agent-old', hostname: 'old' });
    d.attachCliViewer(viewer, 'agent-old');
    const before = d.getState('agent-old');
    d.ingestAgentCli(agent, 'cli:append', appendPayload({ agentId: 'spoof' }));
    assert.deepEqual(viewer.events, []);
    assert.deepEqual(d.getState('agent-old'), before);
    assert.equal(d.listMachines()[0]?.contentIdes, undefined);
  });

  it('drops cli events from a socket that no longer owns the machine', () => {
    const first = fakeSocket('s1');
    const second = fakeSocket('s2');
    const viewer = fakeSocket('viewer');
    d.register(first, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.register(second, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.attachCliViewer(viewer, 'agent-a');
    viewer.events.length = 0;
    d.ingestAgentCli(first, 'cli:append', appendPayload());
    assert.deepEqual(viewer.events, []);
    d.ingestAgentCli(second, 'cli:append', appendPayload());
    assert.equal(viewer.events[0]?.[0], 'cli:append');
  });

  it('forwards cli events with the connection agentId, not the payload agentId', () => {
    const agent = fakeSocket('sa');
    const viewer = fakeSocket('viewer');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.attachCliViewer(viewer, 'agent-a');
    d.ingestAgentCli(agent, 'cli:append', appendPayload({ agentId: 'spoofed' }));
    const payload = viewer.events[0]?.[1][0] as { agentId?: string };
    assert.equal(viewer.events[0]?.[0], 'cli:append');
    assert.equal(payload.agentId, 'agent-a');
  });

  it('keeps cli events inside the machine the viewer is bound to', () => {
    const a = fakeSocket('sa');
    const b = fakeSocket('sb');
    const viewerA = fakeSocket('va');
    const viewerB = fakeSocket('vb');
    d.register(a, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.register(b, { agentId: 'agent-b', hostname: 'B', cliAcp: cursorCli });
    d.attachCliViewer(viewerA, 'agent-a');
    d.attachCliViewer(viewerB, 'agent-b');
    d.ingestAgentCli(a, 'cli:status', {
      epoch: EPOCH,
      source: 'cursor-cli',
      sessionId: SESSION_ID,
      status: 'idle',
    });
    assert.equal(viewerA.events.some(entry => entry[0] === 'cli:status'), true);
    assert.deepEqual(viewerB.events, []);
  });

  it('does not deliver a late cli event across a fast A→B→A switch', async () => {
    const a = fakeSocket('sa');
    const b = fakeSocket('sb');
    const viewer = fakeSocket('viewer');
    const stayed = fakeSocket('stayed');
    d.register(a, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.register(b, { agentId: 'agent-b', hostname: 'B', cliAcp: cursorCli });
    d.attachCliViewer(stayed, 'agent-b');
    const queue = holdQueue();
    const state = { generation: 0 };
    const rooms = {
      leave: () => queue.hold(),
      join: () => queue.hold(),
    };
    const joined: string[] = [];
    const tracking = {
      leave: () => rooms.leave(),
      join: async (room: string) => {
        joined.push(room);
        await rooms.join();
      },
    };

    const toA = bindCliViewer(d, viewer, 'agent-a', state, tracking);
    queue.release();
    await toA;
    assert.equal(state.room, 'machine:agent-a');

    const toB = bindCliViewer(d, viewer, 'agent-b', state, tracking);
    const backToA = bindCliViewer(d, viewer, 'agent-a', state, tracking);
    d.ingestAgentCli(b, 'cli:append', appendPayload());
    d.ingestAgentCli(a, 'cli:append', appendPayload());
    assert.deepEqual(viewer.events, [], '切机未完成时不投递');
    assert.equal(stayed.events.some(entry => entry[0] === 'cli:append'), true);

    queue.release();
    queue.release();
    await Promise.all([toB, backToA]);
    viewer.events.length = 0;
    d.ingestAgentCli(b, 'cli:append', appendPayload());
    d.ingestAgentCli(a, 'cli:status', {
      epoch: EPOCH,
      source: 'cursor-cli',
      sessionId: SESSION_ID,
      status: 'running',
    });
    assert.equal(viewer.events.some(entry => entry[0] === 'cli:append'), false);
    assert.equal(viewer.events.some(entry => entry[0] === 'cli:status'), true);
    assert.equal(joined.includes('machine:agent-b'), false);
    assert.equal(state.room, 'machine:agent-a');
  });

  it('does not touch the session ledger or IDE state for cli events', () => {
    const agent = fakeSocket('sa');
    const viewer = fakeSocket('viewer');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.attachCliViewer(viewer, 'agent-a');
    d.applyFull(agent, { ...emptyCursorState(), agentActivityText: 'ide' });
    const calls = watchStore(sessionStore);
    const leaked: string[] = [];
    d.on('sessions:index', () => leaked.push('sessions:index'));
    d.on('state:full', () => leaked.push('state:full'));
    d.on('state:patch', () => leaked.push('state:patch'));
    const before = structuredClone(d.getState('agent-a'));
    const contentBefore = d.listMachines()[0]?.contentIdes;

    d.ingestAgentCli(agent, 'cli:snapshot', snapshotPayload());
    d.ingestAgentCli(agent, 'cli:full', {
      epoch: EPOCH,
      snapshotId: SNAPSHOT_ID,
      source: 'cursor-cli',
      sessionId: SESSION_ID,
      seq: 0,
      messages: [],
    });
    d.ingestAgentCli(agent, 'cli:append', appendPayload());
    d.ingestAgentCli(agent, 'cli:session-created', {
      epoch: EPOCH,
      source: 'cursor-cli',
      sessionId: SESSION_ID,
      cwd: '/tmp/work',
      status: 'idle',
      seq: 0,
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(leaked, []);
    assert.deepEqual(d.getState('agent-a'), before);
    assert.deepEqual(d.listMachines()[0]?.contentIdes, contentBefore);
    assert.equal(viewer.events.filter(entry => entry[0].startsWith('cli:')).length, 4);
  });

  it('forwards cli_start for the live darwin cliAcp payload', () => {
    const cliAcp = staticCliAcp('darwin', { LIFELINE_LINUX_CDP: '1' });
    assert.deepEqual(cliAcp, {
      protocolVersion: 1,
      platform: 'darwin',
      sources: [{ source: 'cursor-cli' }, { source: 'codebuddy-cli' }],
    });
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, {
      agentId: 'agent-a',
      hostname: 'A',
      platform: 'darwin',
      cliAcp,
    });
    d.sendCommand('agent-a', 'command:cli_start', {
      commandId: 'c-cursor',
      source: 'cursor-cli',
      cwd: '/tmp/work',
    }, browser);
    d.sendCommand('agent-a', 'command:cli_start', {
      commandId: 'c-codebuddy',
      source: 'codebuddy-cli',
      cwd: '/tmp/work',
    }, browser);
    assert.equal(named(agent.events, 'command:cli_start').length, 2);
    assert.deepEqual(browser.events, []);

    const old = fakeSocket('old');
    const oldBrowser = fakeSocket('ob');
    d.register(old, { agentId: 'agent-old', hostname: 'O', platform: 'darwin' });
    d.sendCommand('agent-old', 'command:cli_start', {
      commandId: 'c-old',
      source: 'cursor-cli',
      cwd: '/tmp/work',
    }, oldBrowser);
    assert.deepEqual(named(old.events, 'command:cli_start'), []);
    assert.equal(
      (oldBrowser.events[0]?.[1][0] as CommandResult).errorCode,
      'cli-agent-incompatible',
    );
  });

  it('forwards cli_start to a linux content source and projects its availability', () => {
    const cliAcp = staticCliAcp('linux', {});
    assert.equal(cliAcp?.platform, 'linux');
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, {
      agentId: 'agent-l',
      hostname: 'L',
      platform: 'linux',
      contentSource: true,
      cliAcp,
    });
    d.ingestAgentCli(agent, 'cli:capabilities', {
      epoch: EPOCH,
      platform: 'linux',
      sources: [{ source: 'codebuddy-cli', availability: 'ready', checkedAt: 1 }],
    });
    const listed = d.listMachines().find(m => m.agentId === 'agent-l');
    assert.deepEqual(listed?.cliSources, [
      { source: 'cursor-cli', availability: 'unknown' },
      { source: 'codebuddy-cli', availability: 'ready' },
    ]);
    d.sendCommand('agent-l', 'command:cli_start', {
      commandId: 'c-linux',
      source: 'codebuddy-cli',
      cwd: '/tmp/work',
    }, browser);
    assert.equal(named(agent.events, 'command:cli_start').length, 1);
    assert.deepEqual(browser.events, []);
  });

  it('rejects a cli command before pending or emit when cliAcp was not declared', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    const bystander = fakeSocket('other');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', platform: 'darwin' });
    d.attachCliViewer(bystander, 'agent-a');
    d.sendCommand('agent-a', 'command:cli_start', {
      commandId: 'c-start',
      source: 'cursor-cli',
      cwd: '/tmp/work',
    }, browser);
    assert.deepEqual(named(agent.events, 'command:cli_start'), []);
    assert.deepEqual(browser.events, [[
      'command:result',
      [{
        commandId: 'c-start',
        ok: false,
        errorCode: 'cli-agent-incompatible',
        error: 'CLI agent incompatible',
      } satisfies CommandResult],
    ]]);
    assert.deepEqual(bystander.events, []);
    d.routeResult({ commandId: 'c-start', ok: true }, 'agent-a');
    assert.equal(browser.events.length, 1);
  });

  it('rejects cli commands when the static platform is not a CLI platform', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, {
      agentId: 'agent-a',
      hostname: 'A',
      platform: 'darwin',
      cliAcp: {
        protocolVersion: 1,
        platform: 'win32',
        sources: [{ source: 'cursor-cli' }],
      } as unknown as CliAcpCapability,
    });
    d.sendCommand('agent-a', 'command:cli_start', {
      commandId: 'c-win',
      source: 'cursor-cli',
      cwd: '/tmp/work',
    }, browser);
    assert.deepEqual(named(agent.events, 'command:cli_start'), []);
    assert.equal(
      (browser.events[0]?.[1][0] as CommandResult).errorCode,
      'cli-agent-incompatible',
    );
  });

  it('rejects a cli command whose source was not declared', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.sendCommand('agent-a', 'command:send_message', {
      commandId: 'c-src',
      text: 'hi',
      ide: 'cursor',
      target: { kind: 'cli', source: 'codebuddy-cli', sessionId: SESSION_ID },
    }, browser);
    assert.deepEqual(named(agent.events, 'command:send_message'), []);
    assert.equal(
      (browser.events[0]?.[1][0] as CommandResult).errorCode,
      'cli-agent-incompatible',
    );
  });

  it('still forwards an IDE command that has no cli target', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    const payload = {
      commandId: 'c-ide',
      type: 'new_chat',
      ide: 'cursor',
    } satisfies CommandPayload;
    d.ingestBrowserCommand('agent-a', 'command:new_chat', payload, browser);
    assert.equal(agent.events.some(entry => entry[0] === 'command:new_chat'), true);
    d.sendCommand('agent-a', 'command:send_message', {
      commandId: 'c-text',
      text: 'hi',
      ide: 'cursor',
    }, browser);
    assert.equal(named(agent.events, 'command:send_message').length, 1);
  });

  it('does not let dynamic availability replace the static gate', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.ingestAgentCli(agent, 'cli:capabilities', {
      epoch: EPOCH,
      platform: 'darwin',
      sources: [{
        source: 'cursor-cli',
        availability: 'binary-missing',
        checkedAt: 1,
        detail: 'missing',
      }],
    });
    agent.events.length = 0;
    d.sendCommand('agent-a', 'command:cli_start', {
      commandId: 'c-go',
      source: 'cursor-cli',
      cwd: '/tmp/work',
    }, browser);
    assert.equal(named(agent.events, 'command:cli_start').length, 1);
    assert.deepEqual(browser.events, []);
  });

  it('projects coarse availability and never treats unknown as ready', () => {
    const agent = fakeSocket('sa');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    const initial = d.listMachines()[0]?.cliSources;
    assert.deepEqual(initial, [{ source: 'cursor-cli', availability: 'unknown' }]);
    assert.notEqual(initial?.[0]?.availability, 'ready');

    let changed = 0;
    d.on('machines:changed', () => {
      changed += 1;
    });
    d.ingestAgentCli(agent, 'cli:capabilities', {
      epoch: EPOCH,
      platform: 'darwin',
      key: 'sk-live',
      sources: [{
        source: 'cursor-cli',
        availability: 'unknown',
        checkedAt: 10,
        detail: 'sk-secret-key',
      }],
    });
    assert.equal(changed, 1);
    const row = d.listMachines()[0];
    assert.deepEqual(row?.cliSources, [{ source: 'cursor-cli', availability: 'unknown' }]);
    const wire = JSON.stringify(row);
    assert.equal(wire.includes('sk-secret-key'), false);
    assert.equal(wire.includes('sk-live'), false);
    assert.equal(wire.includes('detail'), false);
    assert.equal(wire.includes('"key"'), false);

    d.ingestAgentCli(agent, 'cli:capabilities', {
      epoch: EPOCH,
      platform: 'darwin',
      sources: [{ source: 'cursor-cli', availability: 'ready', checkedAt: 11 }],
    });
    assert.deepEqual(d.listMachines()[0]?.cliSources, [
      { source: 'cursor-cli', availability: 'ready' },
    ]);
  });

  it('uses a 1000ms sync cooldown and keeps one sync in flight per agent', () => {
    assert.equal(CLI_SYNC_COOLDOWN_MS, 1000);
    const agent = fakeSocket('sa');
    const other = fakeSocket('sb');
    now = 0;
    d = directory();
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.register(other, { agentId: 'agent-b', hostname: 'B', cliAcp: cursorCli });
    assert.equal(named(agent.events, 'cli:sync').length, 1);
    assert.equal(named(other.events, 'cli:sync').length, 1);

    d.requestCliSync('agent-a');
    d.requestCliSync('agent-a');
    assert.equal(named(agent.events, 'cli:sync').length, 1, '在途时合并');

    d.ingestAgentCli(agent, 'cli:snapshot', snapshotPayload());
    now = 999;
    d.requestCliSync('agent-a');
    assert.equal(named(agent.events, 'cli:sync').length, 1, '冷却未到不发下一次');
    now = 1000;
    d.requestCliSync('agent-a');
    assert.equal(named(agent.events, 'cli:sync').length, 2);

    const selected = resolveCliSyncRequest('agent-a', { agentId: 'agent-b', extra: true });
    assert.deepEqual(selected, { ok: true, agentId: 'agent-a' });
    assert.deepEqual(resolveCliSyncRequest('agent-a', 'nope'), {
      ok: false,
      code: 'invalid-payload',
    });
    assert.deepEqual(resolveCliSyncRequest(undefined, {}), {
      ok: false,
      code: 'invalid-payload',
    });
  });

  it('flushes one queued sync after the in-flight snapshot when cooldown has passed', () => {
    const agent = fakeSocket('sa');
    now = 0;
    d = directory({ cliSyncCooldownMs: 10 });
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    now = 10_000;
    d.requestCliSync('agent-a');
    d.requestCliSync('agent-a');
    assert.equal(named(agent.events, 'cli:sync').length, 1);
    d.ingestAgentCli(agent, 'cli:snapshot', snapshotPayload());
    assert.equal(named(agent.events, 'cli:sync').length, 2);
  });

  it('rejects an illegal browser command without forwarding it', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.ingestBrowserCommand('agent-a', 'command:send_message', {
      commandId: 'c-bad',
      nope: true,
    }, browser);
    assert.deepEqual(named(agent.events, 'command:send_message'), []);
    assert.deepEqual(browser.events, [[
      'command:result',
      [{
        commandId: 'c-bad',
        ok: false,
        errorCode: 'invalid-payload',
        error: 'Invalid payload',
      } satisfies CommandResult],
    ]]);
    d.routeResult({ commandId: 'c-bad', ok: true }, 'agent-a');
    assert.equal(browser.events.length, 1);
  });

  it('drops an illegal cli event and caps the log line at 200 characters', () => {
    assert.equal(CLI_INBOUND_LOG_MAX_CHARS, 200);
    const agent = fakeSocket('sa');
    const viewer = fakeSocket('viewer');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.attachCliViewer(viewer, 'agent-a');
    const marker = 'TAILMARKER1234567890';
    const warns = captureWarn(() => {
      d.ingestAgentCli(agent, 'cli:append', {
        blob: `${'x'.repeat(400)}${marker}`,
      });
      d.ingestAgentCli(agent, 'cli:not-a-real-event', appendPayload());
    });
    assert.deepEqual(viewer.events, []);
    assert.equal(warns.length >= 1, true);
    for (const line of warns) {
      assert.equal(line.length <= CLI_INBOUND_LOG_MAX_CHARS, true);
      assert.equal(line.includes(marker), false);
    }
  });

  it('rejects an illegal register before the machine is admitted', () => {
    const agent = fakeSocket('sa');
    const marker = `secret-token-${'z'.repeat(400)}`;
    const warns = captureWarn(() => {
      const accepted = d.registerInbound(agent, { agentId: 'agent-a', token: marker });
      assert.equal(accepted, null);
    });
    assert.equal(d.listMachines().length, 0);
    assert.equal(d.isActiveSocket(agent), false);
    assert.equal(warns.length, 1);
    assert.equal(warns[0]!.length <= CLI_INBOUND_LOG_MAX_CHARS, true);
    assert.equal(warns[0]!.includes(marker), false);

    const ok = d.registerInbound(agent, {
      agentId: 'agent-a',
      hostname: 'A',
      cliAcp: cursorCli,
    });
    assert.equal(ok, 'agent-a');
    assert.equal(d.isActiveSocket(agent), true);
  });

  it('rejects a duplicate command without replacing the original requester', () => {
    const agent = fakeSocket('sa');
    const first = fakeSocket('br1');
    const second = fakeSocket('br2');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c1', type: 'new_chat' }, first);
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c1', type: 'new_chat' }, second);
    assert.equal(named(agent.events, 'command:new_chat').length, 1);
    assert.equal((second.events[0]?.[1][0] as CommandResult).ok, false);
    d.routeResult({ commandId: 'c1', ok: true }, 'agent-a');
    assert.deepEqual(first.events, [['command:result', [{ commandId: 'c1', ok: true }]]]);
    assert.equal(second.events.length, 1);
  });

  it('expires pending commands on the ttl and drops a late result', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    now = 0;
    d = directory({ pendingTtlMs: 1000 });
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c-ttl', type: 'new_chat' }, browser);
    now = 1000;
    d.routeResult({ commandId: 'c-ttl', ok: true }, 'agent-a');
    assert.deepEqual(browser.events, [[
      'command:result',
      [{ commandId: 'c-ttl', ok: false, error: 'Command expired' }],
    ]]);
  });

  it('clears pending for a disconnected browser and still checks the result machine', () => {
    const agent = fakeSocket('sa');
    const other = fakeSocket('sb');
    const browser = fakeSocket('br');
    const kept = fakeSocket('kept');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    d.register(other, { agentId: 'agent-b', hostname: 'B' });
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c-drop', type: 'new_chat' }, browser);
    d.sendCommand('agent-b', 'command:new_chat', { commandId: 'c-keep', type: 'new_chat' }, kept);
    d.releaseRequester(browser);
    d.routeResult({ commandId: 'c-drop', ok: true }, 'agent-a');
    d.routeResult({ commandId: 'c-keep', ok: false, error: 'spoofed' }, 'agent-a');
    d.routeResult({ commandId: 'c-keep', ok: true }, 'agent-b');
    assert.deepEqual(browser.events, []);
    assert.deepEqual(kept.events, [['command:result', [{ commandId: 'c-keep', ok: true }]]]);
  });

  it('drops malformed cli lifecycle events and still forwards a valid one with the connection agentId', () => {
    const agent = fakeSocket('sa');
    const viewer = fakeSocket('viewer');
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.attachCliViewer(viewer, 'agent-a');
    const marker = `TAILMARKER${'m'.repeat(400)}`;
    const events = [
      'cli:session-created',
      'cli:status',
      'cli:approval',
      'cli:approval-resolved',
      'cli:session-removed',
    ] as const;
    const warns = captureWarn(() => {
      for (const event of events) {
        d.ingestAgentCli(agent, event, {});
        d.ingestAgentCli(agent, event, { nope: true, agentId: 'spoof', blob: marker });
      }
    });
    assert.deepEqual(viewer.events, []);
    assert.equal(warns.length, events.length * 2);
    for (const line of warns) {
      assert.equal(line.length <= CLI_INBOUND_LOG_MAX_CHARS, true);
      assert.equal(line.includes(marker), false);
    }

    const approvalId = '44444444-4444-4444-8444-444444444444';
    const valid: Array<[string, Record<string, unknown>]> = [
      ['cli:session-created', {
        epoch: EPOCH,
        source: 'cursor-cli',
        sessionId: SESSION_ID,
        cwd: '/tmp/work',
        status: 'idle',
        seq: 0,
        originCommandId: 'c-origin',
        clientRequestId: 'client-1',
        agentId: 'spoof',
      }],
      ['cli:status', {
        epoch: EPOCH,
        source: 'cursor-cli',
        sessionId: SESSION_ID,
        status: 'running',
        model: 'auto',
        error: 'none',
        agentId: 'spoof',
      }],
      ['cli:approval', {
        epoch: EPOCH,
        source: 'cursor-cli',
        sessionId: SESSION_ID,
        agentId: 'spoof',
        approval: {
          approvalId,
          sessionId: SESSION_ID,
          title: 'run',
          options: [{ optionId: 'opt', label: 'Allow', kind: 'allow_once' }],
          state: 'pending',
        },
      }],
      ['cli:approval-resolved', {
        epoch: EPOCH,
        source: 'cursor-cli',
        sessionId: SESSION_ID,
        approvalId,
        resolution: 'allow_once',
        agentId: 'spoof',
      }],
      ['cli:session-removed', {
        epoch: EPOCH,
        source: 'cursor-cli',
        sessionId: SESSION_ID,
        agentId: 'spoof',
      }],
    ];
    for (const [event, payload] of valid)
      d.ingestAgentCli(agent, event, payload);
    assert.deepEqual(viewer.events.map(entry => entry[0]), valid.map(([event]) => event));
    for (const [, args] of viewer.events) {
      const payload = args[0] as { agentId?: string };
      assert.equal(payload.agentId, 'agent-a');
    }
  });

  it('rejects a command result whose errorCode is not a wire code', () => {
    const agent = fakeSocket('sa');
    const browser = fakeSocket('br');
    d.register(agent, { agentId: 'agent-a', hostname: 'A' });
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c-code', type: 'new_chat' }, browser);
    d.routeResult({
      commandId: 'c-code',
      ok: false,
      errorCode: 'sync-error',
    } as CommandResult, 'agent-a');
    assert.deepEqual(browser.events, []);
    d.routeResult({ commandId: 'c-code', ok: false, error: 'still here' }, 'agent-a');
    assert.deepEqual(browser.events, [[
      'command:result',
      [{ commandId: 'c-code', ok: false, error: 'still here' }],
    ]]);

    const withData = fakeSocket('data');
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c-data', type: 'new_chat' }, withData);
    d.routeResult({ commandId: 'c-data', ok: true, data: { sessionId: SESSION_ID } }, 'agent-a');
    assert.deepEqual(withData.events, [[
      'command:result',
      [{ commandId: 'c-data', ok: true, data: { sessionId: SESSION_ID } }],
    ]]);

    const coded = fakeSocket('coded');
    d.sendCommand('agent-a', 'command:new_chat', { commandId: 'c-known', type: 'new_chat' }, coded);
    d.routeResult({ commandId: 'c-known', ok: false, errorCode: 'provider-error' }, 'agent-a');
    assert.deepEqual(coded.events, [[
      'command:result',
      [{ commandId: 'c-known', ok: false, errorCode: 'provider-error' }],
    ]]);
  });

  it('does not let an invalid snapshot block the next cli sync', () => {
    const agent = fakeSocket('sa');
    const viewer = fakeSocket('viewer');
    now = 0;
    d = directory();
    d.register(agent, { agentId: 'agent-a', hostname: 'A', cliAcp: cursorCli });
    d.attachCliViewer(viewer, 'agent-a');
    assert.equal(named(agent.events, 'cli:sync').length, 1);

    d.requestCliSync('agent-a');
    assert.equal(named(agent.events, 'cli:sync').length, 1);
    now = CLI_SYNC_COOLDOWN_MS;
    d.ingestAgentCli(agent, 'cli:snapshot', { nope: true });
    assert.equal(viewer.events.some(entry => entry[0] === 'cli:snapshot'), false);
    assert.equal(named(agent.events, 'cli:sync').length, 2, '排队的 sync 在坏快照后发出');

    d.ingestAgentCli(agent, 'cli:snapshot', {});
    now = CLI_SYNC_COOLDOWN_MS * 2;
    d.requestCliSync('agent-a');
    assert.equal(named(agent.events, 'cli:sync').length, 3, '坏快照不再占住 in-flight');
    assert.equal(viewer.events.some(entry => entry[0] === 'cli:snapshot'), false);
  });

  it('registers every browser command, including the cli commands', () => {
    assert.deepEqual(browserCommandEventNames(), [...ALL_COMMAND_EVENTS]);
    assert.equal(browserCommandEventNames().includes('command:cli_start'), true);
    assert.equal(browserCommandEventNames().includes('command:cli_close'), true);
    assert.equal(browserCommandEventNames().includes('command:cli_permission_response'), true);
    // Deliberate tripwire, not a derived value (the deepEqual above already pins the contents):
    // bump it when a command lands in `COMMAND_EVENTS` / `CLI_COMMAND_EVENTS`.
    assert.equal(browserCommandEventNames().length, 21);
  });
});
