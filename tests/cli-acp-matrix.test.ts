import type { CliAcpCapability, CliPermissionResponse, CliSource, CommandPayload, CommandResult } from '@lifeline/protocol';
import type { CDPBridge } from '../packages/agent/src/cdp/bridge.js';
import type { CommandTarget } from '../packages/agent/src/command-router.js';
import type { AcpClientEvent, AcpPermissionRespondResult } from '../packages/agent/src/drivers/acp/types.js';
import type { CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';
import type { AgentSocket } from '../packages/server/src/agent-hub.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { parseIde, SESSION_PAGE_ITEMS } from '@lifeline/protocol';
import { CliSessionManager } from '../packages/agent/src/cli-session-manager.js';
import { attachCommandHandlers } from '../packages/agent/src/command-router.js';
import { createLiveCliEntry } from '../packages/agent/src/drivers/acp/live-entry.js';
import { AgentDirectory } from '../packages/server/src/agent-hub.js';
import { IdentityStore } from '../packages/server/src/identity-store.js';
import { SessionStore } from '../packages/server/src/session-store.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const RAW_PROVIDER_ID = '1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function sessionIdsOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value)
      sessionIdsOf(item, found);
    return found;
  }
  if (!isRecord(value))
    return found;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'sessionId' && typeof item === 'string')
      found.push(item);
    else
      sessionIdsOf(item, found);
  }
  return found;
}

/**
 * Two providers that both answer session/new with the raw id "1".
 * Prompt, permission, and stop stay on the Lifeline session that was addressed.
 */
class RawIdClient {
  readonly providerSessionId = RAW_PROVIDER_ID;
  readonly calls: string[] = [];
  readonly respondCalls: CliPermissionResponse[] = [];
  promptText: string | undefined;
  promptSettled = false;
  cancelSettled = false;
  hangCancel = false;
  private readonly onEvent: (event: AcpClientEvent) => void;
  private readonly cancelGate = deferred<void>();

  constructor(onEvent: (event: AcpClientEvent) => void) {
    this.onEvent = onEvent;
  }

  start(): Promise<void> {
    this.calls.push('start');
    return Promise.resolve();
  }

  initialize(): Promise<{ protocolVersion: number }> {
    this.calls.push('initialize');
    return Promise.resolve({ protocolVersion: 1 });
  }

  sessionNew(): Promise<{ sessionId: string; models: unknown[]; modes: unknown[] }> {
    this.calls.push('session/new');
    return Promise.resolve({ sessionId: this.providerSessionId, models: [], modes: [] });
  }

  prompt(text: string): Promise<{ stopReason: string }> {
    this.calls.push('prompt');
    this.promptText = text;
    return new Promise<{ stopReason: string }>(() => {}).then((result) => {
      this.promptSettled = true;
      return result;
    });
  }

  cancel(): Promise<void> {
    this.calls.push('cancel');
    if (!this.hangCancel)
      return Promise.resolve();
    return this.cancelGate.promise.then(() => {
      this.cancelSettled = true;
    });
  }

  close(): Promise<void> {
    this.calls.push('close');
    this.onEvent({ type: 'exit', code: 0, signal: null });
    return Promise.resolve();
  }

  releaseCancel(): void {
    this.cancelGate.resolve();
  }

  emitPermission(raw: unknown): void {
    this.onEvent({
      type: 'permission',
      raw,
      respond: (response) => {
        this.calls.push('respond');
        this.respondCalls.push(response);
        return Promise.resolve({ ok: true } satisfies AcpPermissionRespondResult);
      },
    });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function permissionRaw(source: CliSource): Record<string, unknown> {
  if (source === 'codebuddy-cli') {
    return {
      sessionId: RAW_PROVIDER_ID,
      toolCall: { title: '读取文件', kind: 'read', rawInput: {} },
      options: [{ optionId: 'allow', name: '允许', kind: 'allow' }],
    };
  }
  return {
    sessionId: RAW_PROVIDER_ID,
    toolCall: { toolCallId: 'tool-1', title: 'npm test', kind: 'execute', rawInput: {} },
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow-once' }],
  };
}

function approvalIdFor(events: Emitted[], sessionId: string): string {
  const card = events.find(event => event.event === 'cli:approval' && event.payload.sessionId === sessionId)?.payload.approval;
  if (!isRecord(card) || typeof card.approvalId !== 'string')
    throw new Error(`missing approval for ${sessionId}`);
  return card.approvalId;
}

describe('ACP matrix gaps', { concurrency: 1, timeout: 10_000 }, () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs)
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lifeline-acp-matrix-'));
    dirs.push(dir);
    return dir;
  }

  it('addresses prompt, stop, and permission per session when both providers use raw id 1', async () => {
    const cwd = tempDir();
    const events: Emitted[] = [];
    const clients: RawIdClient[] = [];
    const manager = new CliSessionManager({
      epoch: EPOCH,
      emit: (event, payload) => {
        events.push({ event, payload: isRecord(payload) ? payload : {} });
      },
      createClient: (input) => {
        const client = new RawIdClient(input.onEvent);
        client.hangCancel = input.source === 'codebuddy-cli';
        clients.push(client);
        return client;
      },
    });

    const cursor = await manager.start({ source: 'cursor-cli', cwd });
    const codebuddy = await manager.start({ source: 'codebuddy-cli', cwd });
    assert.equal(cursor.ok, true);
    assert.equal(codebuddy.ok, true);
    if (!cursor.ok || !codebuddy.ok)
      return;
    const cursorId = cursor.data.sessionId;
    const codebuddyId = codebuddy.data.sessionId;
    const cursorClient = clients[0];
    const codebuddyClient = clients[1];
    assert.ok(cursorClient && codebuddyClient);
    assert.equal(cursorClient.providerSessionId, RAW_PROVIDER_ID);
    assert.equal(codebuddyClient.providerSessionId, RAW_PROVIDER_ID);
    assert.notEqual(cursorId, codebuddyId);
    assert.match(cursorId, UUID_PATTERN);
    assert.match(codebuddyId, UUID_PATTERN);

    const firstPrompt = manager.prompt({
      source: 'cursor-cli',
      sessionId: cursorId,
      text: 'from-cursor',
      clientMessageId: 'm-cursor',
    });
    assert.equal(firstPrompt instanceof Promise, false);
    assert.deepEqual(firstPrompt, { ok: true });
    assert.deepEqual(manager.prompt({
      source: 'cursor-cli',
      sessionId: cursorId,
      text: 'again',
      clientMessageId: 'm-again',
    }), { ok: false, state: 'busy' });
    assert.deepEqual(manager.prompt({
      source: 'cursor-cli',
      sessionId: codebuddyId,
      text: 'wrong-source',
      clientMessageId: 'm-wrong',
    }), { ok: false, errorCode: 'invalid-payload' });
    assert.deepEqual(manager.prompt({
      source: 'codebuddy-cli',
      sessionId: codebuddyId,
      text: 'from-codebuddy',
      clientMessageId: 'm-codebuddy',
    }), { ok: true });
    assert.equal(cursorClient.promptText, 'from-cursor');
    assert.equal(codebuddyClient.promptText, 'from-codebuddy');
    assert.deepEqual(cursorClient.calls.filter(call => call === 'prompt'), ['prompt']);
    assert.deepEqual(codebuddyClient.calls.filter(call => call === 'prompt'), ['prompt']);

    cursorClient.emitPermission(permissionRaw('cursor-cli'));
    codebuddyClient.emitPermission(permissionRaw('codebuddy-cli'));
    const pending = manager.respond({
      source: 'cursor-cli',
      sessionId: cursorId,
      approvalId: approvalIdFor(events, cursorId),
      response: { outcome: 'selected', optionId: 'allow-once' },
    });
    assert.deepEqual(cursorClient.respondCalls, [{ outcome: 'selected', optionId: 'allow-once' }]);
    assert.deepEqual(codebuddyClient.respondCalls, []);
    assert.equal(cursorClient.promptSettled, false);
    assert.equal(codebuddyClient.promptSettled, false);
    assert.deepEqual(await pending, { ok: true });
    assert.equal(events.filter(event => event.event === 'cli:approval-resolved' && event.payload.sessionId === codebuddyId).length, 0);

    const stopped = manager.admitStop({ source: 'codebuddy-cli', sessionId: codebuddyId });
    assert.equal(stopped instanceof Promise, false);
    assert.deepEqual(stopped, { ok: true });
    assert.deepEqual(codebuddyClient.calls.filter(call => call === 'cancel'), ['cancel']);
    assert.deepEqual(cursorClient.calls.filter(call => call === 'cancel'), []);
    assert.equal(codebuddyClient.cancelSettled, false);
    assert.deepEqual(codebuddyClient.respondCalls, [{ outcome: 'cancelled' }]);
    assert.equal(
      events.filter(event => event.event === 'cli:approval-resolved' && event.payload.sessionId === codebuddyId).at(-1)?.payload.resolution,
      'cancelled',
    );
    assert.equal(
      events.filter(event => event.event === 'cli:approval-resolved' && event.payload.sessionId === cursorId).at(-1)?.payload.resolution,
      'allowed',
    );
    assert.equal(cursorClient.promptSettled, false);
    assert.equal(codebuddyClient.promptSettled, false);

    const ids = sessionIdsOf(events);
    assert.ok(ids.length > 0);
    assert.ok(ids.every(id => id !== RAW_PROVIDER_ID));
    assert.equal(JSON.stringify(events).includes(`"sessionId":"${RAW_PROVIDER_ID}"`), false);

    codebuddyClient.releaseCancel();
    await flush();
    await manager.stopAll();
  });

  it('runs a permission result and a stop while the prompt is still pending', async () => {
    const cwd = tempDir();
    const events: Emitted[] = [];
    let onEvent: ((event: AcpClientEvent) => void) | undefined;
    let promptStarted = false;
    let promptSettled = false;
    let cancelStarted = false;
    let cancelSettled = false;
    let sessionClosed = false;
    const respondCalls: CliPermissionResponse[] = [];
    let releaseCancel: () => void = () => {};
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const entry = createLiveCliEntry({
      epoch: EPOCH,
      platform: 'darwin',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
      },
      emit: (event, payload) => {
        events.push({ event, payload: isRecord(payload) ? payload : {} });
      },
      construct: (options) => {
        onEvent = options.onEvent;
        return {
          async start() {},
          async initialize() {
            return { protocolVersion: 1 };
          },
          async sessionNew() {
            return { sessionId: RAW_PROVIDER_ID, models: [], modes: [] };
          },
          prompt() {
            promptStarted = true;
            return new Promise<{ stopReason: string }>(() => {}).then((result) => {
              promptSettled = true;
              return result;
            });
          },
          cancel() {
            cancelStarted = true;
            return cancelGate.then(() => {
              cancelSettled = true;
            });
          },
          async close() {
            sessionClosed = true;
          },
        };
      },
    });

    const started = await entry.start({ source: 'cursor-cli', cwd });
    assert.equal(started.ok, true);
    if (!started.ok)
      return;
    assert.notEqual(started.data.sessionId, RAW_PROVIDER_ID);
    const target = { kind: 'cli' as const, source: 'cursor-cli' as const, sessionId: started.data.sessionId };
    entry.acceptSend({
      commandId: 'msg-1',
      target,
      text: 'hello',
      clientMessageId: 'client-1',
    });
    assert.equal(promptStarted, true);
    assert.equal(promptSettled, false);
    assert.equal(events.find(event => event.event === 'command:result' && event.payload.commandId === 'msg-1')?.payload.ok, true);

    onEvent?.({
      type: 'permission',
      raw: permissionRaw('cursor-cli'),
      respond: async (response) => {
        respondCalls.push(response);
        return { ok: true };
      },
    });
    const approvalId = approvalIdFor(events, started.data.sessionId);
    const choice = {
      target,
      approvalId,
      response: { outcome: 'selected' as const, optionId: 'allow-once' },
    };
    entry.acceptPermission({ commandId: 'perm-1', ...choice });
    entry.acceptPermission({ commandId: 'perm-2', ...choice });
    await flush();
    assert.deepEqual(respondCalls, [{ outcome: 'selected', optionId: 'allow-once' }]);
    assert.equal(promptSettled, false);
    const resolvedAt = events.findIndex(event => event.event === 'cli:approval-resolved' && event.payload.approvalId === approvalId);
    const resultAt = events.findIndex(event => event.event === 'command:result' && event.payload.commandId === 'perm-1');
    assert.ok(resolvedAt >= 0 && resultAt > resolvedAt);
    assert.equal(events[resolvedAt]?.payload.resolution, 'allowed');
    assert.equal(events[resultAt]?.payload.ok, true);
    const again = events.find(event => event.event === 'command:result' && event.payload.commandId === 'perm-2');
    assert.equal(again?.payload.ok, false);
    assert.equal(again?.payload.error, 'already-resolved');
    assert.equal(again?.payload.errorCode, undefined);

    onEvent?.({
      type: 'permission',
      raw: permissionRaw('cursor-cli'),
      respond: async (response) => {
        respondCalls.push(response);
        return { ok: true };
      },
    });
    const mark = events.length;
    entry.acceptStop({ commandId: 'stop-1', target });
    const tail = events.slice(mark);
    const cancelledAt = tail.findIndex(event => event.event === 'cli:approval-resolved' && event.payload.resolution === 'cancelled');
    const stopAt = tail.findIndex(event => event.event === 'command:result' && event.payload.commandId === 'stop-1');
    assert.ok(cancelledAt >= 0 && stopAt > cancelledAt);
    assert.equal(tail[stopAt]?.payload.ok, true);
    assert.equal(cancelStarted, true);
    assert.equal(cancelSettled, false);
    assert.equal(promptSettled, false);
    assert.equal(sessionClosed, false);
    assert.equal(respondCalls.at(-1)?.outcome, 'cancelled');

    releaseCancel();
    entry.acceptClose({ commandId: 'close-1', target });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (sessionClosed)
        break;
      await flush();
    }
    assert.equal(sessionClosed, true);
  });

  it('keeps an existing session promptable after a readiness probe', async () => {
    const cwd = tempDir();
    const events: Emitted[] = [];
    let sessionClosed = false;
    let constructCalls = 0;
    let probeSessions = 0;
    let probeClosed = false;
    const entry = createLiveCliEntry({
      epoch: EPOCH,
      platform: 'darwin',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
      },
      emit: (event, payload) => {
        events.push({ event, payload: isRecord(payload) ? payload : {} });
      },
      construct: () => {
        constructCalls += 1;
        return {
          async start() {},
          async initialize() {
            return { protocolVersion: 1 };
          },
          async sessionNew() {
            return { sessionId: RAW_PROVIDER_ID, models: [], modes: [] };
          },
          prompt() {
            return new Promise(() => {});
          },
          async cancel() {},
          async close() {
            sessionClosed = true;
          },
        };
      },
      probeOpen: () => ({
        async start() {},
        async initialize() {
          return { protocolVersion: 1 };
        },
        async sessionNew() {
          probeSessions += 1;
          return { sessionId: 'probe-session' };
        },
        async close() {
          probeClosed = true;
        },
      }),
    });

    const started = await entry.start({ source: 'cursor-cli', cwd });
    assert.equal(started.ok, true);
    if (!started.ok)
      return;
    assert.equal(constructCalls, 1);
    const probed = await entry.probe('cursor-cli');
    assert.equal(probed.availability, 'unknown');
    assert.equal(probeSessions, 0);
    assert.equal(probeClosed, true);
    assert.equal(sessionClosed, false);
    assert.equal(constructCalls, 1);
    const prompted = entry.manager.prompt({
      source: 'cursor-cli',
      sessionId: started.data.sessionId,
      text: 'still-here',
      clientMessageId: 'after-probe',
    });
    assert.deepEqual(prompted, { ok: true });
    const stopped = entry.manager.admitStop({ source: 'cursor-cli', sessionId: started.data.sessionId });
    assert.deepEqual(stopped, { ok: true });
    assert.equal(sessionClosed, false);
    const mark = events.length;
    entry.manager.snapshotForSync();
    const snapshot = events.slice(mark).find(event => event.event === 'cli:snapshot');
    const sessions = snapshot?.payload.sessions;
    assert.equal(Array.isArray(sessions) && sessions.length, 1);
    await entry.manager.close({ source: 'cursor-cli', sessionId: started.data.sessionId });
    assert.equal(sessionClosed, true);
  });

  it('probes without opening a session, and a fifth live session stays open', async () => {
    const cwd = tempDir();
    const events: Emitted[] = [];
    const closed: boolean[] = [];
    let constructCalls = 0;
    let probeOpens = 0;
    let probeSessions = 0;
    const entry = createLiveCliEntry({
      epoch: EPOCH,
      platform: 'darwin',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
      },
      emit: (event, payload) => {
        events.push({ event, payload: isRecord(payload) ? payload : {} });
      },
      construct: () => {
        const index = constructCalls;
        constructCalls += 1;
        closed[index] = false;
        return {
          async start() {},
          async initialize() {
            return { protocolVersion: 1 };
          },
          async sessionNew() {
            return { sessionId: RAW_PROVIDER_ID, models: [], modes: [] };
          },
          prompt() {
            return new Promise(() => {});
          },
          async cancel() {},
          async close() {
            closed[index] = true;
          },
        };
      },
      probeOpen: () => {
        probeOpens += 1;
        return {
          async start() {},
          async initialize() {
            return { protocolVersion: 1 };
          },
          async sessionNew() {
            probeSessions += 1;
            return { sessionId: 'probe-session' };
          },
          async close() {},
        };
      },
    });

    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const started = await entry.start({ source: 'cursor-cli', cwd });
      if (!started.ok)
        assert.fail(started.errorCode);
      ids.push(started.data.sessionId);
    }
    assert.equal(constructCalls, 4);
    assert.equal(new Set(ids).size, 4);

    const probed = await entry.probe('cursor-cli');
    assert.equal(probed.availability, 'unknown');
    assert.equal(probeOpens, 1);
    assert.equal(probeSessions, 0);
    assert.equal(constructCalls, 4);
    assert.deepEqual(closed, [false, false, false, false]);

    const fifth = await entry.start({ source: 'cursor-cli', cwd });
    assert.equal(fifth.ok, true);
    assert.equal(constructCalls, 5);
    assert.deepEqual(closed.slice(0, 4), [false, false, false, false]);

    const mark = events.length;
    entry.manager.snapshotForSync();
    const snapshot = events.slice(mark).find(event => event.event === 'cli:snapshot');
    const sessions = snapshot?.payload.sessions;
    assert.equal(Array.isArray(sessions) && sessions.length, 5);
    assert.deepEqual(closed.slice(0, 4), [false, false, false, false]);
  });
});

const cursorCli: CliAcpCapability = {
  protocolVersion: 1,
  platform: 'darwin',
  sources: [{ source: 'cursor-cli' }],
};

const codebuddyCli: CliAcpCapability = {
  protocolVersion: 1,
  platform: 'darwin',
  sources: [{ source: 'codebuddy-cli' }],
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

function appendPayload(source: 'cursor-cli' | 'codebuddy-cli', text: string) {
  return {
    epoch: EPOCH,
    source,
    sessionId: SESSION_ID,
    seq: 1,
    messages: [{ id: 'm1', type: 'human', flatIndex: 0, text }],
  };
}

describe('ACP matrix subscription and IDE regression', { concurrency: 1, timeout: 10_000 }, () => {
  let dir: string;
  let store: IdentityStore;
  let sessionStore: SessionStore;
  let directory: AgentDirectory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifeline-acp-matrix-hub-'));
    store = new IdentityStore(join(dir, 'identity.sqlite'));
    sessionStore = new SessionStore(join(dir, 'sessions.sqlite'));
    directory = new AgentDirectory(store, {
      persistDebounceMs: 0,
      now: () => 1_000,
      sessionStore,
    });
  });

  afterEach(() => {
    directory.dispose();
    sessionStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('isolates two users and two sockets, and drops a superseded agent socket', () => {
    const alice = fakeSocket('alice-1');
    const aliceNext = fakeSocket('alice-2');
    const bob = fakeSocket('bob-agent');
    const phone = fakeSocket('phone');
    const browser = fakeSocket('browser');
    const bobViewer = fakeSocket('bob-viewer');
    directory.register(alice, {
      agentId: 'agent-a',
      hostname: 'A',
      owner: 'alice',
      instanceId: 'inst-a1',
      cliAcp: cursorCli,
    });
    directory.register(bob, {
      agentId: 'agent-b',
      hostname: 'B',
      owner: 'bob',
      instanceId: 'inst-b1',
      cliAcp: codebuddyCli,
    });
    directory.attachCliViewer(phone, 'agent-a');
    directory.attachCliViewer(browser, 'agent-a');
    directory.attachCliViewer(bobViewer, 'agent-b');

    assert.deepEqual(directory.listMachines('alice').map(machine => machine.agentId), ['agent-a']);
    assert.deepEqual(directory.listMachines('bob').map(machine => machine.agentId), ['agent-b']);
    assert.deepEqual(directory.listMachines('carol'), []);
    assert.deepEqual(directory.listMachines('alice')[0]?.cliSources, [
      { source: 'cursor-cli', availability: 'unknown' },
    ]);
    assert.deepEqual(directory.listMachines('bob')[0]?.cliSources, [
      { source: 'codebuddy-cli', availability: 'unknown' },
    ]);

    directory.ingestAgentCli(alice, 'cli:append', appendPayload('cursor-cli', 'alice'));
    assert.equal(named(phone.events, 'cli:append').length, 1);
    assert.equal(named(browser.events, 'cli:append').length, 1);
    assert.deepEqual(bobViewer.events, []);

    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    };
    try {
      directory.register(aliceNext, {
        agentId: 'agent-a',
        hostname: 'A',
        owner: 'alice',
        instanceId: 'inst-a2',
        cliAcp: cursorCli,
      });
    }
    finally {
      console.warn = orig;
    }
    assert.ok(warned.length > 0);
    const superseded = alice.events.find(entry => entry[0] === 'agent:superseded');
    const body = superseded?.[1][0];
    assert.equal(isRecord(body) && body.reason, 'duplicate-agent');
    assert.equal(isRecord(body) && isRecord(body.by) && body.by.instanceId, 'inst-a2');
    assert.equal(isRecord(body) && isRecord(body.by) && body.by.socketId, 'alice-2');
    assert.equal(directory.isActiveSocket(alice), false);
    assert.equal(directory.isActiveSocket(aliceNext), true);
    assert.equal(aliceNext.events.some(entry => entry[0] === 'agent:superseded'), false);

    phone.events.length = 0;
    browser.events.length = 0;
    const dropped: string[] = [];
    console.warn = (...args: unknown[]) => {
      dropped.push(args.map(String).join(' '));
    };
    try {
      directory.ingestAgentCli(alice, 'cli:append', appendPayload('cursor-cli', 'stale'));
    }
    finally {
      console.warn = orig;
    }
    assert.deepEqual(phone.events, []);
    assert.deepEqual(browser.events, []);
    directory.ingestAgentCli(aliceNext, 'cli:append', appendPayload('cursor-cli', 'fresh'));
    directory.ingestAgentCli(bob, 'cli:append', appendPayload('codebuddy-cli', 'bob'));
    assert.equal(named(phone.events, 'cli:append').length, 1);
    assert.equal(named(browser.events, 'cli:append').length, 1);
    const phoneBody = named(phone.events, 'cli:append')[0]?.[0];
    assert.equal(isRecord(phoneBody) && phoneBody.agentId, 'agent-a');
    assert.equal(JSON.stringify(phone.events).includes('bob'), false);
    assert.equal(named(bobViewer.events, 'cli:append').length, 1);
    assert.equal(JSON.stringify(bobViewer.events).includes('fresh'), false);

    directory.ingestAgentCli(aliceNext, 'cli:capabilities', {
      epoch: EPOCH,
      platform: 'darwin',
      sources: [{ source: 'cursor-cli', availability: 'credential-required', checkedAt: 5 }],
    });
    assert.deepEqual(directory.listMachines('alice')[0]?.cliSources, [
      { source: 'cursor-cli', availability: 'credential-required' },
    ]);
    assert.deepEqual(directory.listMachines('bob')[0]?.cliSources, [
      { source: 'codebuddy-cli', availability: 'unknown' },
    ]);
    aliceNext.events.length = 0;
    const requester = fakeSocket('requester');
    directory.sendCommand('agent-a', 'command:send_message', {
      commandId: 'c-send',
      text: 'hello',
      clientMessageId: 'msg-1',
      target: { kind: 'cli', source: 'cursor-cli', sessionId: SESSION_ID },
    }, requester);
    directory.sendCommand('agent-a', 'command:stop', {
      commandId: 'c-stop',
      target: { kind: 'cli', source: 'cursor-cli', sessionId: SESSION_ID },
    }, requester);
    directory.sendCommand('agent-a', 'command:approve', {
      commandId: 'c-approve',
      selectorPath: 'approval/0',
      ide: 'cursor',
    }, requester);
    directory.sendCommand('agent-a', 'command:switch_tab', {
      commandId: 'c-tab',
      tabTitle: 'Chat',
      ide: 'cursor',
    }, requester);
    assert.equal(named(aliceNext.events, 'command:send_message').length, 1);
    assert.equal(named(aliceNext.events, 'command:stop').length, 1);
    assert.equal(named(aliceNext.events, 'command:approve').length, 1);
    assert.equal(named(aliceNext.events, 'command:switch_tab').length, 1);
    assert.deepEqual(requester.events, []);
    directory.sendCommand('agent-a', 'command:cli_start', {
      commandId: 'c-other',
      source: 'codebuddy-cli',
      cwd: '/tmp/work',
    }, requester);
    assert.equal(named(aliceNext.events, 'command:cli_start').length, 0);
    assert.equal((requester.events[0]?.[1][0] as CommandResult).errorCode, 'cli-agent-incompatible');
  });
});

describe('ACP matrix IDE regression', { concurrency: 1, timeout: 10_000 }, () => {
  it('keeps IDE approve, switch_tab, paging, and census off the CLI path', async () => {
    assert.equal(parseIde('cursor-cli'), 'cursor');
    assert.equal(SESSION_PAGE_ITEMS, 200);
    const reporter = readFileSync(new URL('../packages/agent/src/session-index-reporter.ts', import.meta.url), 'utf8');
    assert.equal(reporter.includes('cursor-cli'), false);
    assert.equal(reporter.includes('codebuddy-cli'), false);
    assert.equal(reporter.includes('cli:'), false);

    const results: CommandResult[] = [];
    const calls: string[] = [];
    const executor = new Proxy({} as CommandExecutor, {
      get(_target, prop) {
        if (prop === 'then')
          return undefined;
        return async (commandId: string) => {
          calls.push(String(prop));
          return { commandId, ok: true };
        };
      },
    });
    const bridge = new Proxy({} as CDPBridge, {
      get(_target, prop) {
        if (prop === 'then')
          return undefined;
        if (prop === 'activeTargetId')
          return '';
        return () => Promise.resolve();
      },
    });
    const target: CommandTarget = {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
      pauseLive: () => {},
    };
    const handlers = new Map<string, Array<(payload: CommandPayload) => unknown>>();
    attachCommandHandlers((event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }, target);
    async function emit(event: string, payload: CommandPayload): Promise<void> {
      const list = handlers.get(event) ?? [];
      await Promise.all(list.map(handler => Promise.resolve(handler(payload))));
    }

    const cliTarget = { kind: 'cli' as const, source: 'cursor-cli' as const, sessionId: SESSION_ID };
    await emit('command:approve', {
      commandId: 'cli-approve',
      selectorPath: 'approval/0',
      ide: 'cursor',
      target: cliTarget,
    });
    await emit('command:switch_tab', {
      commandId: 'cli-tab',
      tabTitle: 'Chat',
      ide: 'cursor',
      target: cliTarget,
    });
    assert.deepEqual(calls, []);
    assert.equal(results[0]?.errorCode, 'wrong-target');
    assert.equal(results[1]?.errorCode, 'wrong-target');

    await emit('command:approve', {
      commandId: 'ide-approve',
      selectorPath: 'approval/0',
      ide: 'cursor',
    });
    await emit('command:switch_tab', {
      commandId: 'ide-tab',
      tabTitle: 'Chat',
      ide: 'cursor',
    });
    assert.deepEqual(calls, ['clickApproval', 'switchTab']);
    assert.equal(results[2]?.ok, true);
    assert.equal(results[3]?.ok, true);
  });
});
