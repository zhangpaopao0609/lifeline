import type { CliModelCatalog, CliPermissionResponse, CliSource } from '@lifeline/protocol';
import type { CursorParameterState } from '../packages/agent/src/drivers/acp/session-catalog.js';
import type { AcpClientEvent, AcpPermissionRespondResult } from '../packages/agent/src/drivers/acp/types.js';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  checkSyncWireBudget,
  checkWireBudget,
  CLI_APPEND_MAX_BYTES,
  CLI_ELEMENT_MAX_BYTES,
  CLI_FULL_MAX_BYTES,
  CLI_SESSION_BODY_MAX_BYTES,
  CLI_SYNC_MAX_BYTES,
  cliAppendSchema,
  cliFullSchema,
  cliSnapshotSchema,
  wireBytes,
} from '@lifeline/protocol';
import { CliSessionManager, nextSyncAttempt } from '../packages/agent/src/cli-session-manager.js';
import { AcpTimelineAssembler } from '../packages/agent/src/drivers/acp/assemble.js';
import { codebuddyProjectSlug } from '../packages/agent/src/drivers/acp/codebuddy-cli-transcript.js';
import { JsonlRpcError } from '../packages/agent/src/drivers/acp/jsonl-rpc.js';
import { attachCliUplinkSync } from '../packages/agent/src/drivers/acp/live-entry.js';
import { codebuddyAcpProfile, cursorAcpProfile } from '../packages/agent/src/drivers/acp/profiles.js';
import { readCliSessionLedger, writeCliSessionLedger } from '../packages/agent/src/drivers/acp/session-ledger.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const PROVIDER_SESSION_ID = 'provider-session-should-stay-inside';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function cursorPermission(options?: Array<{ optionId: string; name: string; kind: string }>) {
  return {
    toolCall: {
      toolCallId: 'tool-1',
      title: 'npm test',
      kind: 'execute',
      rawInput: {},
    },
    options: options ?? [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow-once' },
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow-always' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject-once' },
    ],
  };
}

function classifyPermission(
  source: CliSource,
  raw: unknown,
  response: CliPermissionResponse,
): AcpPermissionRespondResult {
  if (response.outcome === 'cancelled')
    return { ok: true };
  const profile = source === 'cursor-cli' ? cursorAcpProfile : codebuddyAcpProfile;
  const options = isRecord(raw) && Array.isArray(raw.options) ? raw.options : [];
  const option = options.find(item => isRecord(item) && item.optionId === response.optionId);
  const kind = profile.mapOptionKind(isRecord(option) && typeof option.kind === 'string' ? option.kind : '');
  if (kind === 'unknown')
    return { ok: false, state: 'unsupported-permission-option' };
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class FakeClient {
  readonly providerSessionId = PROVIDER_SESSION_ID;
  readonly calls: string[] = [];
  readonly respondCalls: CliPermissionResponse[] = [];
  protocolVersion = 1;
  blockStart = false;
  blockSessionNew = false;
  failStart: Error | undefined;
  failSessionNew: Error | undefined;
  loadError: Error | undefined;
  loadUpdates: unknown[] = [];
  loadCatalog: CliModelCatalog | undefined;
  catalog: CliModelCatalog | undefined;
  modelConfigId: string | undefined;
  thinkingConfigId: string | undefined;
  cursorParameters: CursorParameterState | undefined;
  readonly configCalls: Array<{ configId: string; value: string }> = [];
  promptText: string | undefined;
  hangRespond = false;
  hangClose = false;
  killGraceMs: number | undefined;
  trace: string[] | undefined;
  traceId = 'session';
  private readonly onEvent: (event: AcpClientEvent) => void;
  private readonly source: CliSource;
  private readonly startGate = deferred<void>();
  private readonly sessionNewGate = deferred<void>();
  private promptGate = deferred<{ stopReason: string }>();
  private readonly respondGate = deferred<AcpPermissionRespondResult>();
  private promptStarted = false;
  private readonly closeGate = deferred<void>();

  constructor(source: CliSource, onEvent: (event: AcpClientEvent) => void) {
    this.source = source;
    this.onEvent = onEvent;
  }

  start(): Promise<void> {
    this.calls.push('start');
    if (this.blockStart) {
      return this.startGate.promise.then(() => {
        if (this.failStart)
          throw this.failStart;
      });
    }
    if (this.failStart)
      return Promise.reject(this.failStart);
    return Promise.resolve();
  }

  initialize(): Promise<{ protocolVersion: number }> {
    this.calls.push('initialize');
    return Promise.resolve({ protocolVersion: this.protocolVersion });
  }

  sessionNew(): Promise<{ sessionId: string; models: unknown[]; modes: unknown[] }> {
    this.calls.push('session/new');
    const finish = () => {
      if (this.failSessionNew)
        throw this.failSessionNew;
      return {
        sessionId: this.providerSessionId,
        models: [],
        modes: [],
        ...(this.catalog ? { catalog: this.catalog } : {}),
        ...(this.modelConfigId ? { modelConfigId: this.modelConfigId } : {}),
        ...(this.thinkingConfigId ? { thinkingConfigId: this.thinkingConfigId } : {}),
        ...(this.cursorParameters ? { cursorParameters: this.cursorParameters } : {}),
      };
    };
    if (this.blockSessionNew)
      return this.sessionNewGate.promise.then(finish);
    return Promise.resolve(finish());
  }

  sessionLoad(input: { sessionId: string }): Promise<{ sessionId: string; models: unknown[]; modes: unknown[] }> {
    this.calls.push('session/load');
    this.onEvent({
      type: 'update',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hello again' },
      },
    });
    for (const update of this.loadUpdates)
      this.onEvent({ type: 'update', update });
    if (this.loadError)
      return Promise.reject(this.loadError);
    return Promise.resolve({
      sessionId: input.sessionId,
      models: [],
      modes: [],
      ...(this.loadCatalog ? { catalog: this.loadCatalog } : {}),
      ...(this.modelConfigId ? { modelConfigId: this.modelConfigId } : {}),
      ...(this.thinkingConfigId ? { thinkingConfigId: this.thinkingConfigId } : {}),
      ...(this.cursorParameters ? { cursorParameters: this.cursorParameters } : {}),
    });
  }

  prompt(text: string): Promise<{ stopReason: string }> {
    this.calls.push('prompt');
    this.promptText = text;
    this.promptStarted = true;
    return this.promptGate.promise;
  }

  cancel(): Promise<void> {
    this.calls.push('cancel');
    this.trace?.push(`${this.traceId}:session-cancel`);
    return Promise.resolve();
  }

  setConfigOption(configId: string, value: string): Promise<unknown> {
    this.calls.push('set_config_option');
    this.configCalls.push({ configId, value });
    return Promise.resolve(undefined);
  }

  close(): Promise<void> {
    this.calls.push('close');
    this.trace?.push(`${this.traceId}:close`);
    const finish = () => {
      this.onEvent({ type: 'exit', code: 0, signal: null });
    };
    if (this.hangClose)
      return this.closeGate.promise.then(finish);
    finish();
    return Promise.resolve();
  }

  releaseClose(): void {
    this.closeGate.resolve();
  }

  releaseStart(): void {
    this.startGate.resolve();
  }

  releaseSessionNew(): void {
    this.sessionNewGate.resolve();
  }

  finishPrompt(stopReason = 'end_turn'): void {
    this.promptGate.resolve({ stopReason });
  }

  /** Rejects the in-flight prompt and leaves the child running. */
  rejectPrompt(err: Error = new Error('provider failed')): void {
    const gate = this.promptGate;
    this.promptGate = deferred();
    this.promptStarted = false;
    gate.reject(err);
  }

  crash(): void {
    if (this.promptStarted)
      this.promptGate.reject(new Error('process exited'));
    this.onEvent({ type: 'exit', code: 1, signal: null });
  }

  emitUpdate(update: unknown): void {
    this.onEvent({ type: 'update', update });
  }

  releaseRespond(result: AcpPermissionRespondResult = { ok: true }): void {
    this.respondGate.resolve(result);
  }

  emitPermission(raw: unknown): void {
    this.onEvent({
      type: 'permission',
      raw,
      respond: (response) => {
        this.calls.push('respond');
        this.respondCalls.push(response);
        if (response.outcome === 'cancelled')
          this.trace?.push(`${this.traceId}:approval-cancel`);
        if (this.hangRespond)
          return this.respondGate.promise;
        return Promise.resolve(classifyPermission(this.source, raw, response));
      },
    });
  }
}

interface Rig {
  manager: CliSessionManager;
  events: Emitted[];
  clients: FakeClient[];
  cwd: string;
  epoch: string;
  trace: string[];
  sourceLive: Array<{ source: string; live: number }>;
  prepare: (client: FakeClient) => void;
}

function createRig(
  cwd: string,
  ledgerPath?: string,
  codebuddyProjectsRoot?: string,
  cursorModels?: () => ReadonlyArray<{ id: string; label: string }> | undefined,
  now?: () => number,
  catalogPath?: string,
): Rig {
  const events: Emitted[] = [];
  const clients: FakeClient[] = [];
  const trace: string[] = [];
  const sourceLive: Array<{ source: string; live: number }> = [];
  const rig: Rig = {
    events,
    clients,
    cwd,
    epoch: EPOCH,
    trace,
    sourceLive,
    prepare: () => {},
    manager: undefined as unknown as CliSessionManager,
  };
  rig.manager = new CliSessionManager({
    epoch: EPOCH,
    ...(ledgerPath ? { ledgerPath } : {}),
    ...(codebuddyProjectsRoot ? { codebuddyProjectsRoot } : {}),
    ...(cursorModels ? { cursorModels } : {}),
    ...(now ? { now } : {}),
    ...(catalogPath ? { catalogPath } : {}),
    onSourceLive(source, live) {
      sourceLive.push({ source, live });
    },
    emit(event, payload) {
      assert.equal(isRecord(payload), true);
      events.push({ event, payload: payload as Record<string, unknown> });
    },
    createClient(input) {
      const client = new FakeClient(input.source, input.onEvent);
      client.killGraceMs = input.killGraceMs;
      client.trace = trace;
      client.traceId = `s${clients.length}`;
      rig.prepare(client);
      clients.push(client);
      return client;
    },
  });
  return rig;
}

function assertNoProviderId(value: unknown): void {
  const stripped = JSON.stringify(value, (key, nested) => key === 'resumeCommand' ? undefined : nested);
  assert.equal(stripped.includes(PROVIDER_SESSION_ID), false);
}

function assertOnlyCliEvents(events: Emitted[]): void {
  const allowed = new Set([
    'cli:session-created',
    'cli:snapshot',
    'cli:full',
    'cli:append',
    'cli:status',
    'cli:approval',
    'cli:approval-resolved',
    'cli:session-removed',
  ]);
  for (const event of events)
    assert.equal(allowed.has(event.event), true, event.event);
  assertNoProviderId(events);
}

function takeSnapshot(rig: Rig) {
  const before = rig.events.length;
  const returned = rig.manager.snapshotForSync();
  assert.equal(returned, undefined);
  const emitted = rig.events.slice(before);
  assert.ok(emitted.length > 0);
  assert.equal(emitted[0]?.event, 'cli:snapshot');
  const snapshot = cliSnapshotSchema.safeParse(emitted[0]?.payload);
  assert.equal(snapshot.success, true, snapshot.success ? '' : snapshot.error.message);
  if (!snapshot.success)
    throw new Error('unreachable');
  assert.equal(snapshot.data.epoch, EPOCH);
  assert.equal('agentId' in snapshot.data, false);
  const fulls = emitted.slice(1);
  assert.equal(fulls.length, snapshot.data.sessions.length);
  for (const [index, session] of snapshot.data.sessions.entries()) {
    assert.equal(fulls[index]?.event, 'cli:full');
    const full = cliFullSchema.safeParse(fulls[index]?.payload);
    assert.equal(full.success, true, full.success ? '' : full.error.message);
    if (!full.success)
      throw new Error('unreachable');
    assert.equal(full.data.epoch, snapshot.data.epoch);
    assert.equal(full.data.snapshotId, snapshot.data.snapshotId);
    assert.equal(full.data.sessionId, session.sessionId);
    assert.equal(full.data.source, session.source);
    assert.equal(full.data.seq, session.seq);
    assert.equal('agentId' in full.data, false);
    assertNoProviderId(full.data);
  }
  assert.equal(emitted.length, snapshot.data.sessions.length + 1);
  return {
    snapshot: snapshot.data,
    fulls: fulls.map(event => cliFullSchema.parse(event.payload)),
  };
}

async function boot(rig: Rig, source: CliSource = 'cursor-cli') {
  const result = await rig.manager.start({
    source,
    cwd: rig.cwd,
    commandId: 'cmd-1',
    clientRequestId: 'req-1',
  });
  assert.equal(result.ok, true);
  if (!result.ok)
    throw new Error('start failed');
  const client = rig.clients.at(-1);
  assert.ok(client);
  if (!client)
    throw new Error('missing client');
  return { sessionId: result.data.sessionId, client, result };
}

function statuses(events: Emitted[]): string[] {
  return events.flatMap((event) => {
    if (event.event !== 'cli:status' && event.event !== 'cli:session-created')
      return [];
    return typeof event.payload.status === 'string' ? [event.payload.status] : [];
  });
}

describe('nextSyncAttempt', () => {
  it('waits, retries once at 120s, then reports sync-error', () => {
    assert.equal(nextSyncAttempt(0, 0), 'wait');
    assert.equal(nextSyncAttempt(119_999, 0), 'wait');
    assert.equal(nextSyncAttempt(119_999, 1), 'wait');
    assert.equal(nextSyncAttempt(120_000, 0), 'retry');
    assert.equal(nextSyncAttempt(180_000, 0), 'retry');
    assert.equal(nextSyncAttempt(120_000, 1), 'sync-error');
    assert.equal(nextSyncAttempt(240_000, 2), 'sync-error');
  });
});

describe('CliSessionManager', { timeout: 180_000 }, () => {
  let cwd = '';

  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'lifeline-cli-session-'));
  });

  after(async () => {
    if (cwd.length > 0)
      await rm(cwd, { recursive: true, force: true });
  });

  it('starts five sessions and lists every one in the snapshot', async () => {
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.blockStart = true;
    };
    const pending = Array.from({ length: 5 }, () => rig.manager.start({ source: 'cursor-cli', cwd }));
    assert.equal(rig.clients.length, 5);
    const mid = takeSnapshot(rig);
    assert.equal(mid.snapshot.sessions.length, 5);
    assert.deepEqual(mid.snapshot.sessions.map(session => session.status), [
      'starting',
      'starting',
      'starting',
      'starting',
      'starting',
    ]);
    for (const client of rig.clients)
      client.releaseStart();
    const started = await Promise.all(pending);
    assert.deepEqual(started.map(result => result.ok), [true, true, true, true, true]);
    await rig.manager.stopAll();
  });

  it('releases the slot when spawn fails and does not keep the session', async () => {
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.blockStart = true;
      client.failStart = new JsonlRpcError('binary-missing', 'binary-missing');
    };
    const pending = rig.manager.start({ source: 'cursor-cli', cwd });
    assert.equal(takeSnapshot(rig).snapshot.sessions.length, 1);
    rig.clients[0]?.releaseStart();
    assert.deepEqual(await pending, { ok: false, errorCode: 'binary-missing' });
    assert.equal(rig.events.some(event => event.event === 'cli:session-removed'), true);
    assert.equal(takeSnapshot(rig).snapshot.sessions.length, 0);
    rig.prepare = () => {};
    const again = await rig.manager.start({ source: 'cursor-cli', cwd });
    assert.equal(again.ok, true);
    await rig.manager.stopAll();
  });

  it('releases the slot when session/new fails', async () => {
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.failSessionNew = new Error('session/new failed');
    };
    assert.deepEqual(await rig.manager.start({ source: 'cursor-cli', cwd }), {
      ok: false,
      errorCode: 'provider-error',
    });
    assert.equal(rig.clients[0]?.calls.includes('close'), true);
    assert.equal(takeSnapshot(rig).snapshot.sessions.length, 0);
  });

  it('releases the slot when the ACP protocol version is not 1', async () => {
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.protocolVersion = 2;
    };
    assert.deepEqual(await rig.manager.start({ source: 'cursor-cli', cwd }), {
      ok: false,
      errorCode: 'unsupported-acp-version',
    });
    assert.equal(takeSnapshot(rig).snapshot.sessions.length, 0);
  });

  it('publishes the session/new catalog on status and snapshot without switching', async () => {
    const catalog: CliModelCatalog = {
      models: [
        { id: 'glm-5.2', label: 'GLM 5.2' },
        { id: 'kimi-k3', label: 'Kimi K3' },
      ],
      currentModelId: 'glm-5.2',
      thinking: {
        current: 'high',
        levels: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
      },
    };
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.catalog = catalog;
    };
    const started = await rig.manager.start({ source: 'codebuddy-cli', cwd });
    assert.equal(started.ok, true);
    assert.deepEqual(rig.clients[0]?.calls, ['start', 'initialize', 'session/new']);
    const status = rig.events.find(event => event.event === 'cli:status' && event.payload.status === 'idle');
    assert.equal(status?.payload.model, 'GLM 5.2');
    assert.deepEqual(status?.payload.catalog, catalog);
    const snap = takeSnapshot(rig);
    assert.equal(snap.snapshot.sessions[0]?.model, 'GLM 5.2');
    assert.deepEqual(snap.snapshot.sessions[0]?.catalog, catalog);
    await rig.manager.stopAll();
  });

  it('reads a catalog from a throwaway session and closes it without publishing', async () => {
    const catalog: CliModelCatalog = {
      models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
      currentModelId: 'glm-5.2',
      thinking: { current: 'high', levels: [{ value: 'high', label: 'High' }] },
    };
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.catalog = catalog;
    };
    const read = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(read.ok, true);
    if (read.ok)
      assert.deepEqual(read.data.catalog, catalog);
    assert.deepEqual(rig.clients[0]?.calls, ['start', 'initialize', 'session/new', 'close']);
    assert.equal(rig.clients[0]?.killGraceMs, 0);
    assert.equal(rig.events.some(event => event.event === 'cli:session-created'), false);
  });

  it('serves a saved CodeBuddy catalog and shares one background refresh', async () => {
    const catalog: CliModelCatalog = {
      models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
      currentModelId: 'glm-5.2',
    };
    let clock = 1_000;
    const rig = createRig(cwd, undefined, undefined, undefined, () => clock);
    rig.prepare = (client) => {
      client.catalog = catalog;
      client.blockSessionNew = true;
    };
    const first = rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    const second = rig.manager.readCatalog({ source: 'codebuddy-cli', cwd: tmpdir() });
    assert.equal(rig.clients.length, 1);
    rig.clients[0]?.releaseSessionNew();
    const read = await first;
    const again = await second;
    assert.equal(read.ok && again.ok, true);
    if (read.ok && again.ok)
      assert.deepEqual(again.data.catalog, read.data.catalog);
    const third = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(rig.clients.length, 1);
    assert.equal(third.ok, true);
    clock += 10 * 60 * 1000;
    const updated: CliModelCatalog = {
      models: [{ id: 'glm-5.3', label: 'GLM 5.3' }],
      currentModelId: 'glm-5.3',
    };
    rig.prepare = (client) => {
      client.catalog = updated;
      client.blockSessionNew = true;
    };
    const fourth = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(fourth.ok, true);
    if (fourth.ok)
      assert.deepEqual(fourth.data.catalog, catalog);
    assert.equal(rig.clients.length, 2);
    const during = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    if (during.ok)
      assert.deepEqual(during.data.catalog, catalog);
    assert.equal(rig.clients.length, 2);
    rig.clients[1]?.releaseSessionNew();
    await new Promise(resolve => setImmediate(resolve));
    const fifth = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(fifth.ok, true);
    if (fifth.ok)
      assert.deepEqual(fifth.data.catalog, updated);
    assert.equal(rig.clients.length, 2);
  });

  it('keeps the saved CodeBuddy list when a refresh fails', async () => {
    const catalog: CliModelCatalog = {
      models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
      currentModelId: 'glm-5.2',
    };
    let clock = 1_000;
    const rig = createRig(cwd, undefined, undefined, undefined, () => clock);
    rig.prepare = (client) => {
      client.catalog = catalog;
    };
    const read = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(read.ok, true);
    clock += 10 * 60 * 1000;
    rig.prepare = (client) => {
      client.failSessionNew = new JsonlRpcError('provider-error', 'provider-error');
    };
    const stale = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(stale.ok, true);
    if (stale.ok)
      assert.deepEqual(stale.data.catalog, catalog);
    await new Promise(resolve => setImmediate(resolve));
    const again = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(again.ok, true);
    if (again.ok)
      assert.deepEqual(again.data.catalog, catalog);
    assert.equal(rig.clients.length, 2);
  });

  it('a later process serves the CodeBuddy catalog saved on disk', async () => {
    const catalog: CliModelCatalog = {
      models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
      currentModelId: 'glm-5.2',
    };
    const catalogPath = path.join(await mkdtemp(path.join(tmpdir(), 'll-catalog-')), 'cli-catalogs.json');
    let clock = 1_000;
    const first = createRig(cwd, undefined, undefined, undefined, () => clock, catalogPath);
    first.prepare = (client) => {
      client.catalog = catalog;
    };
    const read = await first.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(read.ok, true);
    clock += 5 * 60 * 1000;
    const restarted = createRig(cwd, undefined, undefined, undefined, () => clock, catalogPath);
    const again = await restarted.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(again.ok, true);
    if (again.ok)
      assert.deepEqual(again.data.catalog, catalog);
    assert.equal(restarted.clients.length, 1);
  });

  it('does not answer from a CodeBuddy catalog older than a day', async () => {
    const catalog: CliModelCatalog = {
      models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
      currentModelId: 'glm-5.2',
    };
    let clock = 1_000;
    const rig = createRig(cwd, undefined, undefined, undefined, () => clock);
    rig.prepare = (client) => {
      client.catalog = catalog;
    };
    const read = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(read.ok, true);
    clock += 24 * 60 * 60 * 1000;
    rig.prepare = (client) => {
      client.catalog = catalog;
      client.blockSessionNew = true;
    };
    let settled = false;
    const late = rig.manager.readCatalog({ source: 'codebuddy-cli', cwd }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(rig.clients.length, 2);
    rig.clients[1]?.releaseSessionNew();
    const result = await late;
    assert.equal(result.ok, true);
  });

  it('answers the dialog from a live CodeBuddy session without another spawn', async () => {
    const catalog: CliModelCatalog = {
      models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
      currentModelId: 'glm-5.2',
    };
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.catalog = catalog;
    };
    const started = await rig.manager.start({ source: 'codebuddy-cli', cwd });
    assert.equal(started.ok, true);
    const read = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd: tmpdir() });
    assert.equal(read.ok, true);
    if (read.ok)
      assert.deepEqual(read.data.catalog, catalog);
    assert.equal(rig.clients.length, 1);
    await rig.manager.stopAll();
  });

  it('does not cache an empty CodeBuddy catalog', async () => {
    const rig = createRig(cwd);
    const first = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    const second = await rig.manager.readCatalog({ source: 'codebuddy-cli', cwd });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(rig.clients.length, 2);
  });

  it('writes a chosen thinking level with set_config_option and leaves set_model unused', async () => {
    const catalog: CliModelCatalog = {
      models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
      currentModelId: 'glm-5.2',
      thinking: {
        current: 'low',
        levels: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
      },
    };
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.catalog = catalog;
      client.thinkingConfigId = 'thought_level';
    };
    const started = await rig.manager.start({ source: 'codebuddy-cli', cwd, thinking: 'high' });
    assert.equal(started.ok, true);
    assert.deepEqual(rig.clients[0]?.configCalls, [{ configId: 'thought_level', value: 'high' }]);
    assert.equal(rig.clients[0]?.calls.includes('session/set_model'), false);
    const status = rig.events.find(event => event.event === 'cli:status' && event.payload.status === 'idle');
    const reported = status?.payload.catalog as CliModelCatalog | undefined;
    assert.equal(reported?.thinking?.current, 'high');
    await rig.manager.stopAll();
  });

  it('keeps a Cursor dialog choice as one list id, including speed', async () => {
    const listed = [
      { id: 'grok-4.7-low', label: 'Grok 4.7 Low' },
      { id: 'grok-4.7-high-fast', label: 'Grok 4.7 High Fast' },
    ];
    const rig = createRig(cwd, undefined, undefined, () => listed);
    rig.prepare = (client) => {
      client.modelConfigId = 'model';
      client.catalog = {
        currentModelId: 'grok-4.7',
        models: [{ id: 'grok-4.7', label: 'grok-4.7' }],
      };
      client.cursorParameters = {
        modelNames: ['grok-4.7', 'composer-2.5', 'claude-opus-5-high'],
        modelId: 'grok-4.7',
        effort: {
          id: 'reasoning_effort',
          value: 'high',
          values: ['low', 'medium', 'high', 'xhigh'],
        },
        fast: { id: 'fast', value: 'true', values: ['false', 'true'] },
      };
    };
    const started = await rig.manager.start({
      source: 'cursor-cli',
      cwd,
      modelId: 'grok-4.7-low',
    });
    assert.equal(started.ok, true);
    if (!started.ok)
      return;
    assert.deepEqual(rig.clients[0]?.configCalls, [
      { configId: 'reasoning_effort', value: 'low' },
      { configId: 'fast', value: 'false' },
    ]);
    const reported = [...rig.events].reverse().find(event => event.event === 'cli:status')?.payload.catalog as CliModelCatalog;
    assert.equal(reported.currentModelId, 'grok-4.7-low');
    assert.equal(reported.thinking, undefined);
    assert.equal(reported.models.every(model => model.thinking == null), true);
    assert.equal(reported.models.find(model => model.id === 'grok-4.7-low')?.label, 'Grok 4.7 Low');
    const changed = await rig.manager.selectModel({
      source: 'cursor-cli',
      sessionId: started.data.sessionId,
      modelId: 'grok-4.7-high-fast',
    });
    assert.equal(changed.ok, true);
    assert.deepEqual(rig.clients[0]?.configCalls.slice(-2), [
      { configId: 'reasoning_effort', value: 'high' },
      { configId: 'fast', value: 'true' },
    ]);
    const after = [...rig.events].reverse().find(event => event.event === 'cli:status')?.payload.catalog as CliModelCatalog;
    assert.equal(after.currentModelId, 'grok-4.7-high-fast');
    assert.equal(rig.clients[0]?.calls.includes('session/set_model'), false);
    await rig.manager.stopAll();
  });

  it('rewrites the cursor model id when the in-session thinking level changes', async () => {
    const catalog: CliModelCatalog = {
      models: [{
        id: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
        label: 'grok-4.7',
        thinking: {
          current: 'high',
          levels: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
          ],
        },
      }],
      currentModelId: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
    };
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.catalog = structuredClone(catalog);
      client.modelConfigId = 'model';
    };
    const started = await rig.manager.start({ source: 'cursor-cli', cwd });
    assert.equal(started.ok, true);
    if (!started.ok)
      return;
    const changed = await rig.manager.selectThinking({
      source: 'cursor-cli',
      sessionId: started.data.sessionId,
      thinking: 'low',
    });
    assert.equal(changed.ok, true);
    assert.deepEqual(rig.clients[0]?.configCalls, [{
      configId: 'model',
      value: 'grok-4.7[context=256k,reasoning_effort=low,fast=true]',
    }]);
    assert.equal(rig.clients[0]?.calls.includes('session/set_model'), false);
    const reported = [...rig.events].reverse().find(event => event.event === 'cli:status')?.payload.catalog as CliModelCatalog;
    assert.equal(reported.currentModelId, 'grok-4.7[context=256k,reasoning_effort=low,fast=true]');
    assert.equal(reported.models[0]?.thinking?.current, 'low');
    assert.equal(reported.models[0]?.id, 'grok-4.7[context=256k,reasoning_effort=low,fast=true]');
    const refused = await rig.manager.selectThinking({
      source: 'cursor-cli',
      sessionId: started.data.sessionId,
      thinking: 'minimal',
    });
    assert.deepEqual(refused, { ok: false, errorCode: 'invalid-payload' });
    await rig.manager.stopAll();
  });

  it('reloads a recorded session after the process stops and forgets it when the user closes it', async () => {
    const ledger = path.join(cwd, 'cli-sessions.json');
    const first = createRig(cwd, ledger);
    const started = await first.manager.start({ source: 'codebuddy-cli', cwd });
    assert.equal(started.ok, true);
    const saved = readCliSessionLedger(ledger);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.providerSessionId, PROVIDER_SESSION_ID);
    assert.equal(first.events.some(event => Object.hasOwn(event.payload, 'providerSessionId')), false);
    const resumeCommand = [...first.events].reverse().find(event => event.event === 'cli:status')?.payload.resumeCommand;
    assert.equal(typeof resumeCommand, 'string');
    assert.equal(String(resumeCommand).includes(PROVIDER_SESSION_ID), true);
    await first.manager.stopAll();
    assert.equal(readCliSessionLedger(ledger).length, 1);

    const restored = createRig(cwd, ledger);
    await restored.manager.restore();
    assert.equal(restored.clients[0]?.calls.includes('session/load'), true);
    assert.equal(restored.clients[0]?.calls.includes('session/new'), false);
    const full = restored.events.find(event => event.event === 'cli:full');
    const messages = full?.payload.messages as Array<{ type?: string; text?: string }> | undefined;
    assert.equal(messages?.some(message => message.type === 'human' && message.text === 'hello again'), true);
    const created = restored.events.find(event => event.event === 'cli:session-created');
    const sessionId = created?.payload.sessionId;
    assert.equal(typeof sessionId, 'string');
    await restored.manager.close({ source: 'codebuddy-cli', sessionId: sessionId as string });
    assert.deepEqual(readCliSessionLedger(ledger), []);
  });

  it('restores the saved model and thinking, and ignores the model stamped on a replayed reply', async () => {
    const ledger = path.join(cwd, 'cli-sessions-model.json');
    const first = createRig(cwd, ledger);
    first.prepare = (client) => {
      client.catalog = {
        currentModelId: 'deepseek-v4.1-flash',
        models: [
          {
            id: 'deepseek-v4.1-flash',
            label: 'DeepSeek-V4.1-Flash',
            thinking: {
              current: 'max',
              levels: [{ value: 'low', label: 'Low' }, { value: 'max', label: 'Max' }],
            },
          },
        ],
        thinking: {
          current: 'max',
          levels: [{ value: 'low', label: 'Low' }, { value: 'max', label: 'Max' }],
        },
      };
    };
    const started = await first.manager.start({ source: 'codebuddy-cli', cwd });
    assert.equal(started.ok, true);
    assert.equal(readCliSessionLedger(ledger)[0]?.modelId, 'deepseek-v4.1-flash');
    assert.equal(readCliSessionLedger(ledger)[0]?.thinking, 'max');
    await first.manager.stopAll();

    const restored = createRig(cwd, ledger);
    restored.prepare = (client) => {
      client.modelConfigId = 'model';
      client.thinkingConfigId = 'thought_level';
      client.loadCatalog = {
        currentModelId: 'gpt-5.6-sol',
        models: [
          {
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6-Sol',
            thinking: { levels: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
          },
          {
            id: 'deepseek-v4.1-flash',
            label: 'DeepSeek-V4.1-Flash',
            thinking: { levels: [{ value: 'low', label: 'Low' }, { value: 'max', label: 'Max' }] },
          },
        ],
        thinking: {
          current: 'high',
          levels: [{ value: 'high', label: 'High' }, { value: 'max', label: 'Max' }],
        },
      };
      client.loadUpdates = [{
        sessionUpdate: 'agent_message_chunk',
        _meta: { 'codebuddy.ai/requestModelId': 'gpt-5.6-sol' },
      }];
    };
    await restored.manager.restore();
    const status = [...restored.events].reverse().find(event => event.event === 'cli:status');
    const catalog = status?.payload.catalog as CliModelCatalog;
    assert.equal(catalog.currentModelId, 'deepseek-v4.1-flash');
    assert.equal(status?.payload.model, 'DeepSeek-V4.1-Flash');
    assert.equal(catalog.thinking?.current, 'max');
    assert.deepEqual(restored.clients[0]?.configCalls, [
      { configId: 'model', value: 'deepseek-v4.1-flash' },
      { configId: 'thought_level', value: 'max' },
    ]);
    assert.equal(String(status?.payload.resumeCommand).includes('--model'), true);
    assert.equal(String(status?.payload.resumeCommand).includes('deepseek-v4.1-flash'), true);
    assert.equal(String(status?.payload.resumeCommand).includes('--effort'), true);
    assert.equal(String(status?.payload.resumeCommand).includes('max'), true);
    assert.equal(restored.clients[0]?.calls.includes('session/set_model'), false);
    await restored.manager.stopAll();
  });

  it('leaves the loaded model alone when the ledger has no saved choice', async () => {
    const ledger = path.join(cwd, 'cli-sessions-replay.json');
    const first = createRig(cwd, ledger);
    const started = await first.manager.start({ source: 'codebuddy-cli', cwd });
    assert.equal(started.ok, true);
    await first.manager.stopAll();
    const restored = createRig(cwd, ledger);
    restored.prepare = (client) => {
      client.modelConfigId = 'model';
      client.loadCatalog = {
        currentModelId: 'gpt-5.6-sol',
        models: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
          { id: 'deepseek-v4.1-flash', label: 'DeepSeek-V4.1-Flash' },
        ],
      };
      client.loadUpdates = [{
        sessionUpdate: 'agent_message_chunk',
        _meta: { 'codebuddy.ai/requestModelId': 'deepseek-v4.1-flash' },
      }];
    };
    await restored.manager.restore();
    assert.deepEqual(restored.clients[0]?.configCalls, []);
    const status = [...restored.events].reverse().find(event => event.event === 'cli:status');
    assert.equal((status?.payload.catalog as CliModelCatalog).currentModelId, 'gpt-5.6-sol');
    await restored.manager.stopAll();
  });

  it('restores a Cursor effort saved inside the model id', async () => {
    const ledger = path.join(cwd, 'cli-sessions-cursor.json');
    writeCliSessionLedger(ledger, [{
      source: 'cursor-cli',
      cwd: realpathSync(cwd),
      providerSessionId: PROVIDER_SESSION_ID,
      modelId: 'grok-4.7[reasoning_effort=low,fast=true]',
    }]);
    const restored = createRig(cwd, ledger, undefined, () => [
      { id: 'grok-4.7-low-fast', label: 'Grok 4.7 Low Fast' },
      { id: 'grok-4.7-high-fast', label: 'Grok 4.7 High Fast' },
    ]);
    restored.prepare = (client) => {
      client.modelConfigId = 'model';
      client.loadCatalog = {
        currentModelId: 'grok-4.7',
        models: [{ id: 'grok-4.7', label: 'grok-4.7' }],
      };
      client.cursorParameters = {
        modelNames: ['grok-4.7'],
        modelId: 'grok-4.7',
        effort: { id: 'reasoning_effort', value: 'high', values: ['low', 'high'] },
        fast: { id: 'fast', value: 'true', values: ['false', 'true'] },
      };
    };
    await restored.manager.restore();
    assert.deepEqual(restored.clients[0]?.configCalls, [
      { configId: 'reasoning_effort', value: 'low' },
    ]);
    const command = String([...restored.events].reverse().find(event => event.event === 'cli:status')?.payload.resumeCommand);
    assert.equal(command.includes('cursor-agent --resume'), true);
    assert.equal(command.includes('\'grok-4.7-low-fast\''), true);
    assert.equal(command.includes('--effort'), false);
    assert.equal(restored.clients[0]?.calls.includes('session/set_model'), false);
    await restored.manager.stopAll();
  });

  it('switches the open session model with set_config_option and leaves set_model unused', async () => {
    const ledger = path.join(cwd, 'cli-sessions-switch.json');
    const rig = createRig(cwd, ledger);
    rig.prepare = (client) => {
      client.modelConfigId = 'model';
      client.catalog = {
        currentModelId: 'gpt-5.6-sol',
        models: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
          { id: 'deepseek-v4.1-flash', label: 'DeepSeek-V4.1-Flash' },
        ],
      };
    };
    const started = await rig.manager.start({ source: 'codebuddy-cli', cwd });
    assert.equal(started.ok, true);
    if (!started.ok)
      return;
    const switched = await rig.manager.selectModel({
      source: 'codebuddy-cli',
      sessionId: started.data.sessionId,
      modelId: 'deepseek-v4.1-flash',
    });
    assert.equal(switched.ok, true);
    assert.deepEqual(rig.clients[0]?.configCalls, [{ configId: 'model', value: 'deepseek-v4.1-flash' }]);
    assert.equal(rig.clients[0]?.calls.includes('session/set_model'), false);
    const status = [...rig.events].reverse().find(event => event.event === 'cli:status');
    const catalog = status?.payload.catalog as CliModelCatalog;
    assert.equal(catalog.currentModelId, 'deepseek-v4.1-flash');
    assert.equal(status?.payload.model, 'DeepSeek-V4.1-Flash');
    assert.equal(readCliSessionLedger(ledger)[0]?.modelId, 'deepseek-v4.1-flash');
    assert.equal(String(status?.payload.resumeCommand).includes('\'deepseek-v4.1-flash\''), true);
    await rig.manager.stopAll();
  });

  it('writes a thinking level from the chosen model and skips one that model does not list', async () => {
    const catalog: CliModelCatalog = {
      models: [
        {
          id: 'glm-5.2',
          label: 'GLM 5.2',
          thinking: { levels: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
        },
        {
          id: 'deepseek-v4.1-flash',
          label: 'DeepSeek V4.1 Flash',
          thinking: { levels: [{ value: 'low', label: 'Low' }, { value: 'max', label: 'Max' }] },
        },
      ],
      currentModelId: 'glm-5.2',
      thinking: {
        current: 'low',
        levels: [
          { value: 'minimal', label: 'Minimal' },
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
          { value: 'max', label: 'Max' },
        ],
      },
    };
    const refused = createRig(cwd);
    refused.prepare = (client) => {
      client.catalog = structuredClone(catalog);
      client.modelConfigId = 'model';
      client.thinkingConfigId = 'thought_level';
    };
    const skipped = await refused.manager.start({
      source: 'codebuddy-cli',
      cwd,
      modelId: 'deepseek-v4.1-flash',
      thinking: 'minimal',
    });
    assert.equal(skipped.ok, true);
    assert.deepEqual(refused.clients[0]?.configCalls, [
      { configId: 'model', value: 'deepseek-v4.1-flash' },
    ]);
    await refused.manager.stopAll();

    const accepted = createRig(cwd);
    accepted.prepare = (client) => {
      client.catalog = structuredClone(catalog);
      client.modelConfigId = 'model';
      client.thinkingConfigId = 'thought_level';
    };
    const started = await accepted.manager.start({
      source: 'codebuddy-cli',
      cwd,
      modelId: 'deepseek-v4.1-flash',
      thinking: 'max',
    });
    assert.equal(started.ok, true);
    assert.deepEqual(accepted.clients[0]?.configCalls, [
      { configId: 'model', value: 'deepseek-v4.1-flash' },
      { configId: 'thought_level', value: 'max' },
    ]);
    await accepted.manager.stopAll();
  });

  it('rejects a cwd that is not an absolute directory before creating a client', async () => {
    const rig = createRig(cwd);
    const file = path.join(cwd, 'not-a-directory.txt');
    writeFileSync(file, 'x');
    const cases = ['relative/path', path.join(cwd, 'missing-dir'), file];
    for (const candidate of cases) {
      assert.deepEqual(await rig.manager.start({ source: 'cursor-cli', cwd: candidate }), {
        ok: false,
        errorCode: 'invalid-cwd',
      });
    }
    assert.equal(rig.clients.length, 0);
    assert.equal(takeSnapshot(rig).snapshot.sessions.length, 0);
  });

  it('stores the realpath of a directory symlink', async () => {
    const rig = createRig(cwd);
    const target = await mkdtemp(path.join(cwd, 'target-'));
    const link = path.join(cwd, 'cwd-link');
    symlinkSync(target, link, 'dir');
    const result = await rig.manager.start({ source: 'cursor-cli', cwd: link });
    assert.equal(result.ok, true);
    if (!result.ok)
      return;
    const created = rig.events.find(event => event.event === 'cli:session-created');
    assert.equal(created?.payload.cwd, realpathSync(link));
    assert.notEqual(created?.payload.cwd, link);
    await rig.manager.stopAll();
  });

  it('returns a Lifeline session id and broadcasts session-created followed by an empty full', async () => {
    const rig = createRig(cwd);
    const result = await rig.manager.start({
      source: 'cursor-cli',
      cwd,
      commandId: 'cmd-1',
      clientRequestId: 'req-1',
    });
    assert.equal(result.ok, true);
    if (!result.ok)
      return;
    assert.deepEqual(Object.keys(result.data).sort(), ['epoch', 'sessionId', 'source']);
    assert.deepEqual(result.data, {
      epoch: EPOCH,
      source: 'cursor-cli',
      sessionId: result.data.sessionId,
    });
    assert.notEqual(result.data.sessionId, PROVIDER_SESSION_ID);
    assert.match(result.data.sessionId, UUID_PATTERN);
    assert.deepEqual(rig.events.map(event => event.event), [
      'cli:session-created',
      'cli:status',
      'cli:full',
    ]);
    const created = rig.events[0]?.payload;
    const full = cliFullSchema.parse(rig.events[2]?.payload);
    assert.deepEqual(created, {
      epoch: EPOCH,
      source: 'cursor-cli',
      sessionId: result.data.sessionId,
      cwd: realpathSync(cwd),
      status: 'starting',
      seq: 0,
      originCommandId: 'cmd-1',
      clientRequestId: 'req-1',
    });
    assert.equal(rig.events[1]?.payload.status, 'idle');
    assert.equal(full.seq, 0);
    assert.deepEqual(full.messages, []);
    assert.equal(full.sessionId, result.data.sessionId);
    assert.equal(full.epoch, EPOCH);
    assert.notEqual(full.snapshotId, result.data.sessionId);
    assertNoProviderId(rig.events);
    assertNoProviderId(result);
    await rig.manager.stopAll();
  });

  it('moves a session from starting through approval and back to idle', async () => {
    const rig = createRig(cwd);
    rig.prepare = (client) => {
      client.blockSessionNew = true;
    };
    const pending = rig.manager.start({ source: 'cursor-cli', cwd });
    await flush();
    const mid = takeSnapshot(rig);
    assert.equal(mid.snapshot.sessions[0]?.status, 'starting');
    assert.equal(mid.snapshot.sessions[0]?.seq, 0);
    assert.deepEqual(mid.fulls[0]?.messages, []);
    const sessionId = mid.snapshot.sessions[0]?.sessionId;
    rig.clients[0]?.releaseSessionNew();
    const started = await pending;
    assert.equal(started.ok, true);
    if (!started.ok || sessionId == null || rig.clients[0] == null)
      return;
    assert.equal(started.data.sessionId, sessionId);
    const admission = rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'hello',
      clientMessageId: 'msg-1',
    });
    assert.equal(admission.ok, true);
    rig.clients[0].emitPermission(cursorPermission());
    const approval = rig.events.find(event => event.event === 'cli:approval');
    const approvalId = isRecord(approval?.payload.approval) ? approval.payload.approval.approvalId : undefined;
    assert.equal(typeof approvalId, 'string');
    if (typeof approvalId !== 'string')
      return;
    assert.deepEqual(await rig.manager.respond({
      source: 'cursor-cli',
      sessionId,
      approvalId,
      response: { outcome: 'selected', optionId: 'allow-once' },
    }), { ok: true });
    rig.clients[0].finishPrompt();
    await flush();
    assert.deepEqual(statuses(rig.events), [
      'starting',
      'idle',
      'running',
      'waiting_approval',
      'running',
      'idle',
    ]);
    await rig.manager.stopAll();
  });

  it('admits a prompt before the provider answers and numbers timeline changes from 1', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    const admission = rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'hello',
      clientMessageId: 'msg-1',
    });
    assert.equal(admission instanceof Promise, false);
    assert.deepEqual(admission, { ok: true });
    assert.equal(client.promptText, 'hello');
    const appends = rig.events.filter(event => event.event === 'cli:append');
    assert.equal(appends.length, 1);
    const first = cliAppendSchema.parse(appends[0]?.payload);
    assert.equal(first.seq, 1);
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0]?.type, 'human');
    client.emitUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ignored' } });
    client.emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'a1',
      content: { type: 'text', text: 'hi' },
    });
    client.emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'a1',
      content: { type: 'text', text: ' there' },
    });
    const seqs = rig.events
      .filter(event => event.event === 'cli:append')
      .map(event => cliAppendSchema.parse(event.payload));
    assert.deepEqual(seqs.map(event => event.seq), [1, 2, 3]);
    const assistant = seqs[2]?.messages[0];
    assert.equal(assistant?.type, 'assistant');
    if (assistant?.type === 'assistant')
      assert.equal(assistant.text, 'hi there');
    const synced = takeSnapshot(rig);
    assert.equal(synced.snapshot.sessions[0]?.seq, 3);
    assert.equal(synced.fulls[0]?.seq, 3);
    assert.equal(synced.fulls[0]?.messages.length, 2);
    client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('returns busy for a second prompt on the same session and allows another session', async () => {
    const rig = createRig(cwd);
    const first = await boot(rig);
    const second = await boot(rig);
    assert.equal(rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: first.sessionId,
      text: 'one',
      clientMessageId: 'm1',
    }).ok, true);
    assert.deepEqual(rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: first.sessionId,
      text: 'two',
      clientMessageId: 'm2',
    }), { ok: false, state: 'busy' });
    assert.equal(first.client.calls.filter(call => call === 'prompt').length, 1);
    assert.equal(rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: second.sessionId,
      text: 'other',
      clientMessageId: 'm3',
    }).ok, true);
    assert.equal(second.client.promptText, 'other');
    first.client.finishPrompt();
    await flush();
    assert.equal(rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: first.sessionId,
      text: 'three',
      clientMessageId: 'm4',
    }).ok, true);
    await rig.manager.stopAll();
  });

  it('does not let a later full reset seq to 0', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'hello',
      clientMessageId: 'msg-1',
    });
    const before = takeSnapshot(rig);
    assert.equal(before.snapshot.sessions[0]?.seq, 1);
    client.emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'a1',
      content: { type: 'text', text: 'after' },
    });
    const append = rig.events.filter(event => event.event === 'cli:append').at(-1);
    assert.equal(cliAppendSchema.parse(append?.payload).seq, 2);
    client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('invalidates the whole approval after one option is claimed', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'run',
      clientMessageId: 'msg-1',
    });
    client.hangRespond = true;
    client.emitPermission(cursorPermission());
    const approval = rig.events.find(event => event.event === 'cli:approval');
    const card = approval?.payload.approval;
    assert.equal(isRecord(card), true);
    if (!isRecord(card) || typeof card.approvalId !== 'string')
      return;
    assert.match(card.approvalId, UUID_PATTERN);
    assert.notEqual(card.approvalId, 'tool-1');
    assert.equal(card.state, 'pending');
    const first = rig.manager.respond({
      source: 'cursor-cli',
      sessionId,
      approvalId: card.approvalId,
      response: { outcome: 'selected', optionId: 'allow-always' },
    });
    const second = await rig.manager.respond({
      source: 'cursor-cli',
      sessionId,
      approvalId: card.approvalId,
      response: { outcome: 'selected', optionId: 'reject-once' },
    });
    assert.deepEqual(second, { ok: false, state: 'already-resolved' });
    assert.equal(takeSnapshot(rig).snapshot.sessions[0]?.approvals[0]?.state, 'resolving');
    assert.equal(client.respondCalls.length, 1);
    client.releaseRespond();
    assert.deepEqual(await first, { ok: true });
    const resolved = rig.events.filter(event => event.event === 'cli:approval-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.payload.resolution, 'allowed');
    assert.equal(takeSnapshot(rig).snapshot.sessions[0]?.approvals.length, 0);
    assert.equal(statuses(rig.events).at(-1), 'running');
    client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('returns unsupported-permission-option for an unknown kind and leaves the card pending', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'run',
      clientMessageId: 'msg-1',
    });
    client.emitPermission(cursorPermission([
      { optionId: 'custom', name: 'Custom', kind: 'mystery' },
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow-once' },
    ]));
    const approval = rig.events.find(event => event.event === 'cli:approval');
    const card = approval?.payload.approval;
    if (!isRecord(card) || typeof card.approvalId !== 'string')
      throw new Error('missing approval');
    assert.deepEqual(await rig.manager.respond({
      source: 'cursor-cli',
      sessionId,
      approvalId: card.approvalId,
      response: { outcome: 'selected', optionId: 'custom' },
    }), { ok: false, state: 'unsupported-permission-option' });
    assert.equal(client.respondCalls.length, 1);
    assert.equal(rig.events.some(event => event.event === 'cli:approval-resolved'), false);
    assert.equal(takeSnapshot(rig).snapshot.sessions[0]?.approvals[0]?.state, 'pending');
    assert.deepEqual(await rig.manager.respond({
      source: 'cursor-cli',
      sessionId,
      approvalId: card.approvalId,
      response: { outcome: 'selected', optionId: 'missing' },
    }), { ok: false, errorCode: 'invalid-payload' });
    assert.equal(client.respondCalls.length, 1);
    assert.deepEqual(await rig.manager.respond({
      source: 'cursor-cli',
      sessionId,
      approvalId: card.approvalId,
      response: { outcome: 'selected', optionId: 'allow-once' },
    }), { ok: true });
    client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('resolves a cancelled response and a reject option with those resolutions', async () => {
    const rig = createRig(cwd);
    const cancelled = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: cancelled.sessionId,
      text: 'run',
      clientMessageId: 'c1',
    });
    cancelled.client.emitPermission(cursorPermission());
    const cancelledId = approvalIdOf(rig);
    assert.deepEqual(await rig.manager.respond({
      source: 'cursor-cli',
      sessionId: cancelled.sessionId,
      approvalId: cancelledId,
      response: { outcome: 'cancelled' },
    }), { ok: true });
    assert.deepEqual(cancelled.client.respondCalls.at(-1), { outcome: 'cancelled' });
    assert.equal(rig.events.filter(event => event.event === 'cli:approval-resolved').at(-1)?.payload.resolution, 'cancelled');
    assert.equal(statuses(rig.events).at(-1), 'running');

    const rejected = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: rejected.sessionId,
      text: 'run',
      clientMessageId: 'c2',
    });
    rejected.client.emitPermission(cursorPermission());
    const rejectedId = approvalIdOf(rig);
    assert.deepEqual(await rig.manager.respond({
      source: 'cursor-cli',
      sessionId: rejected.sessionId,
      approvalId: rejectedId,
      response: { outcome: 'selected', optionId: 'reject-once' },
    }), { ok: true });
    assert.equal(rig.events.filter(event => event.event === 'cli:approval-resolved').at(-1)?.payload.resolution, 'rejected');
    cancelled.client.finishPrompt();
    rejected.client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('keeps a CodeBuddy option id and maps an allow option to allowed', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig, 'codebuddy-cli');
    rig.manager.prompt({
      source: 'codebuddy-cli',
      sessionId,
      text: 'read',
      clientMessageId: 'cb-1',
    });
    client.emitPermission({
      sessionId: PROVIDER_SESSION_ID,
      toolCall: { title: '读取文件', kind: 'read', rawInput: {} },
      options: [
        { optionId: 'allow', name: '允许', kind: 'allow' },
        { optionId: 'reject', name: '拒绝', kind: 'reject' },
      ],
    });
    const card = rig.events.find(event => event.event === 'cli:approval')?.payload.approval;
    assert.equal(isRecord(card), true);
    if (!isRecord(card) || !Array.isArray(card.options))
      return;
    assert.deepEqual(card.options[0], { optionId: 'allow', label: '允许', kind: 'allow_once' });
    assert.equal(typeof card.approvalId, 'string');
    if (typeof card.approvalId !== 'string')
      return;
    assert.deepEqual(await rig.manager.respond({
      source: 'codebuddy-cli',
      sessionId,
      approvalId: card.approvalId,
      response: { outcome: 'selected', optionId: 'allow' },
    }), { ok: true });
    assert.deepEqual(client.respondCalls[0], { outcome: 'selected', optionId: 'allow' });
    assert.equal(rig.events.filter(event => event.event === 'cli:approval-resolved').at(-1)?.payload.resolution, 'allowed');
    assertNoProviderId(rig.events);
    client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('clears a leftover approval when the prompt finishes', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'run',
      clientMessageId: 'msg-1',
    });
    client.emitPermission(cursorPermission());
    client.finishPrompt();
    await flush();
    assert.equal(client.respondCalls.at(-1)?.outcome, 'cancelled');
    assert.equal(rig.events.filter(event => event.event === 'cli:approval-resolved').at(-1)?.payload.resolution, 'cancelled');
    assert.equal(takeSnapshot(rig).snapshot.sessions[0]?.approvals.length, 0);
    assert.equal(statuses(rig.events).at(-1), 'idle');
    await rig.manager.stopAll();
  });

  it('enqueues a snapshot and one full per session, including an empty body, without awaiting', async () => {
    const rig = createRig(cwd);
    const empty = takeSnapshot(rig);
    assert.deepEqual(empty.snapshot.sessions, []);
    assert.deepEqual(empty.fulls, []);
    const first = await boot(rig);
    const second = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: first.sessionId,
      text: 'hello',
      clientMessageId: 'msg-1',
    });
    let drifted = false;
    queueMicrotask(() => {
      drifted = true;
    });
    const synced = takeSnapshot(rig);
    assert.equal(drifted, false);
    assert.deepEqual(synced.snapshot.sessions.map(session => session.sessionId), [
      first.sessionId,
      second.sessionId,
    ]);
    assert.equal(synced.snapshot.sessions[0]?.seq, 1);
    assert.equal(synced.snapshot.sessions[1]?.seq, 0);
    assert.equal(synced.fulls[0]?.messages.length, 1);
    assert.deepEqual(synced.fulls[1]?.messages, []);
    assert.deepEqual(synced.snapshot.sessions[0]?.approvals, []);
    for (const session of synced.snapshot.sessions) {
      assert.equal(typeof session.status, 'string');
      assert.equal(typeof session.seq, 'number');
      assert.ok(Array.isArray(session.approvals));
    }
    first.client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('drops incremental emits while the uplink is down and snapshots the updated assembler when it returns', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    rig.manager.onUplinkDown();
    const mark = rig.events.length;
    assert.equal(rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'offline',
      clientMessageId: 'msg-1',
    }).ok, true);
    client.emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'a1',
      content: { type: 'text', text: 'hidden' },
    });
    assert.deepEqual(rig.events.slice(mark), []);
    rig.manager.onUplinkUp();
    const snapshot = cliSnapshotSchema.parse(rig.events[mark]?.payload);
    const full = cliFullSchema.parse(rig.events[mark + 1]?.payload);
    assert.equal(rig.events[mark]?.event, 'cli:snapshot');
    assert.equal(rig.events[mark + 1]?.event, 'cli:full');
    assert.equal(full.seq, snapshot.sessions[0]?.seq);
    assert.ok(full.seq >= 2);
    assert.equal(full.messages.some(message => message.type === 'human' && message.text === 'offline'), true);
    assert.equal(full.messages.some(message => message.type === 'assistant' && message.text === 'hidden'), true);
    client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('enqueues every cancelled approval before cancel and does not close the process', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'run',
      clientMessageId: 'msg-1',
    });
    client.hangRespond = true;
    client.emitPermission(cursorPermission());
    client.emitPermission(cursorPermission([
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow-once' },
    ]));
    const stopped = await rig.manager.stop({ source: 'cursor-cli', sessionId });
    assert.deepEqual(stopped, { ok: true });
    assert.deepEqual(client.calls.filter(call => call === 'respond' || call === 'cancel' || call === 'close'), [
      'respond',
      'respond',
      'cancel',
    ]);
    assert.deepEqual(client.respondCalls, [
      { outcome: 'cancelled' },
      { outcome: 'cancelled' },
    ]);
    assert.equal(takeSnapshot(rig).snapshot.sessions[0]?.sessionId, sessionId);
    assert.equal(rig.events.some(event => event.event === 'cli:session-removed'), false);
    client.finishPrompt();
    await flush();
    assert.equal(statuses(rig.events).at(-1), 'idle');
    await rig.manager.close({ source: 'cursor-cli', sessionId });
    assert.equal(client.calls.includes('close'), true);
    assert.equal(takeSnapshot(rig).snapshot.sessions.length, 0);
    assert.equal(rig.events.some(event => event.event === 'cli:session-removed'), true);
  });

  it('removes the row before the child process finishes exiting', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    client.hangClose = true;
    let finished = false;
    const pending = rig.manager.close({ source: 'cursor-cli', sessionId }).then(() => {
      finished = true;
    });
    await flush();
    assert.equal(finished, false);
    assert.deepEqual(rig.sourceLive, [{ source: 'cursor-cli', live: 0 }]);
    assert.equal(
      rig.events.some(event => event.event === 'cli:session-removed' && event.payload.sessionId === sessionId),
      true,
    );
    assert.equal(takeSnapshot(rig).snapshot.sessions.some(session => session.sessionId === sessionId), false);
    client.releaseClose();
    await pending;
    assert.equal(finished, true);
    assert.equal(client.calls.includes('close'), true);
  });

  it('keeps the source live while another of its sessions is still open', async () => {
    const rig = createRig(cwd);
    const first = await boot(rig);
    const second = await boot(rig);
    await rig.manager.close({ source: 'cursor-cli', sessionId: first.sessionId });
    assert.deepEqual(rig.sourceLive, [{ source: 'cursor-cli', live: 1 }]);
    await rig.manager.close({ source: 'cursor-cli', sessionId: second.sessionId });
    assert.deepEqual(rig.sourceLive, [
      { source: 'cursor-cli', live: 1 },
      { source: 'cursor-cli', live: 0 },
    ]);
  });

  it('cancels every live session and then closes them on stopAll', async () => {
    const rig = createRig(cwd);
    const first = await boot(rig);
    const second = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: first.sessionId,
      text: 'a',
      clientMessageId: 'a',
    });
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId: second.sessionId,
      text: 'b',
      clientMessageId: 'b',
    });
    first.client.hangRespond = true;
    second.client.hangRespond = true;
    first.client.emitPermission(cursorPermission());
    second.client.emitPermission(cursorPermission());
    await rig.manager.stopAll();
    const approvalAt = rig.trace.map((item, index) => item.endsWith(':approval-cancel') ? index : -1).filter(index => index >= 0);
    const cancelAt = rig.trace.map((item, index) => item.endsWith(':session-cancel') ? index : -1).filter(index => index >= 0);
    const closeAt = rig.trace.map((item, index) => item.endsWith(':close') ? index : -1).filter(index => index >= 0);
    assert.deepEqual(approvalAt, [0, 1]);
    assert.equal(cancelAt.length, 2);
    assert.equal(closeAt.length, 2);
    assert.ok(Math.max(...approvalAt) < Math.min(...cancelAt));
    assert.ok(Math.max(...cancelAt) < Math.min(...closeAt));
    assert.equal(takeSnapshot(rig).snapshot.sessions.length, 0);
    assert.equal(rig.events.filter(event => event.event === 'cli:session-removed').length, 2);
  });

  it('returns to idle when prompt rejects without an exit and admits the next prompt', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    assert.deepEqual(rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'run',
      clientMessageId: 'msg-1',
    }), { ok: true });
    client.emitPermission(cursorPermission());
    const mark = rig.events.length;
    client.rejectPrompt();
    await flush();
    const tail = rig.events.slice(mark);
    assert.equal(tail.some(event => event.payload.error === 'process exited'), false);
    assert.equal(tail.some(event => event.payload.status === 'error'), false);
    assert.equal(tail.some(event => event.payload.resolution === 'expired'), false);
    assert.equal(statuses(rig.events).at(-1), 'idle');
    assert.equal(client.calls.includes('close'), false);
    const again = rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'again',
      clientMessageId: 'msg-2',
    });
    assert.deepEqual(again, { ok: true });
    const snap = takeSnapshot(rig);
    assert.equal(snap.snapshot.sessions.length, 1);
    assert.equal(snap.snapshot.sessions[0]?.sessionId, sessionId);
    assert.equal(snap.snapshot.sessions[0]?.status, 'running');
    client.finishPrompt();
    await flush();
    await rig.manager.stopAll();
  });

  it('keeps a crashed session and its slot until close', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    rig.manager.prompt({
      source: 'cursor-cli',
      sessionId,
      text: 'run',
      clientMessageId: 'msg-1',
    });
    client.emitUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-9',
      title: 'npm test',
      status: 'in_progress',
      kind: 'execute',
    });
    client.emitPermission(cursorPermission());
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    const mark = rig.events.length;
    client.crash();
    await flush();
    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(unhandled, []);
    const tail = rig.events.slice(mark);
    const expiredAt = tail.findIndex(event => event.event === 'cli:approval-resolved' && event.payload.resolution === 'expired');
    const toolAt = tail.findIndex((event) => {
      if (event.event !== 'cli:append')
        return false;
      const parsed = cliAppendSchema.safeParse(event.payload);
      return parsed.success && parsed.data.messages.some(message => message.type === 'tool');
    });
    const statusAt = tail.findIndex(event => event.event === 'cli:status' && event.payload.status === 'error');
    assert.ok(expiredAt >= 0 && toolAt > expiredAt && statusAt > toolAt);
    assert.equal(tail[statusAt]?.payload.error, 'process exited');
    assert.equal(client.calls.includes('close'), false);
    assert.equal(tail.some(event => event.event === 'cli:session-removed'), false);
    const synced = takeSnapshot(rig);
    assert.equal(synced.snapshot.sessions.length, 1);
    assert.equal(synced.snapshot.sessions[0]?.status, 'error');
    assert.equal(synced.snapshot.sessions[0]?.sessionId, sessionId);
    assert.deepEqual(synced.snapshot.sessions[0]?.approvals, []);
    const tool = synced.fulls[0]?.messages.find(message => message.type === 'tool');
    assert.equal(tool?.type, 'tool');
    if (tool?.type === 'tool')
      assert.equal(tool.status, 'error');
    assert.equal(synced.fulls[0]?.messages.some(message => message.type === 'human'), true);
    assert.equal(synced.snapshot.sessions[0]?.seq, synced.fulls[0]?.seq);
    assert.notEqual(synced.fulls[0]?.seq, 0);

    rig.prepare = () => {};
    const extras = [];
    for (let index = 0; index < 3; index += 1)
      extras.push(await rig.manager.start({ source: 'cursor-cli', cwd }));
    assert.deepEqual(extras.map(result => result.ok), [true, true, true]);
    const fifth = await rig.manager.start({ source: 'cursor-cli', cwd });
    assert.equal(fifth.ok, true);
    assert.equal(takeSnapshot(rig).snapshot.sessions.length, 5);
    await rig.manager.close({ source: 'cursor-cli', sessionId });
    assert.equal(rig.events.filter(event => event.event === 'cli:session-removed').some(event => event.payload.sessionId === sessionId), true);
    assert.equal(takeSnapshot(rig).snapshot.sessions.some(session => session.sessionId === sessionId), false);
    const replacement = await rig.manager.start({ source: 'cursor-cli', cwd });
    assert.equal(replacement.ok, true);
    assertOnlyCliEvents(rig.events);
    await rig.manager.stopAll();
  });

  it('cli:sync、断线和重连分别走 snapshot、onUplinkDown、onUplinkUp', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    const handlers = new Map<string, () => void>();
    attachCliUplinkSync((event, handler) => {
      handlers.set(event, handler);
    }, rig.manager, false);
    const mark = rig.events.length;
    handlers.get('cli:sync')?.();
    assert.equal(rig.events[mark]?.event, 'cli:snapshot');
    assert.equal(rig.events[mark + 1]?.event, 'cli:full');
    handlers.get('disconnected')?.();
    const quiet = rig.events.length;
    client.emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'offline',
      content: { type: 'text', text: 'hidden' },
    });
    assert.equal(rig.events.length, quiet);
    handlers.get('connected')?.();
    assert.equal(rig.events[quiet]?.event, 'cli:snapshot');
    assert.equal(rig.events[quiet + 1]?.event, 'cli:full');
    client.finishPrompt();
    await flush();
    await rig.manager.close({ source: 'cursor-cli', sessionId });
  });

  it('已经连上的 uplink 用 onUplinkUp 打快照，不再写第二套实现', async () => {
    const rig = createRig(cwd);
    const { sessionId } = await boot(rig);
    const mark = rig.events.length;
    attachCliUplinkSync(() => {}, rig.manager, true);
    assert.equal(rig.events[mark]?.event, 'cli:snapshot');
    assert.equal(rig.events[mark + 1]?.event, 'cli:full');
    await rig.manager.close({ source: 'cursor-cli', sessionId });
  });

  it('正文未超消息预算但 full 包超 8 MiB 时裁掉头部并带上裁剪标记', { timeout: 60_000 }, async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    const big = 'x'.repeat(CLI_ELEMENT_MAX_BYTES);
    const tail = 't'.repeat(1_048_320);
    for (let i = 0; i < 7; i += 1) {
      client.emitUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: `m${i}`,
        content: { type: 'text', text: big },
      });
    }
    client.emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'tail',
      content: { type: 'text', text: tail },
    });
    const preview = new AcpTimelineAssembler();
    for (let i = 0; i < 7; i += 1)
      preview.apply({ sessionUpdate: 'agent_message_chunk', messageId: `m${i}`, content: { type: 'text', text: big } });
    preview.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'tail', content: { type: 'text', text: tail } });
    const view = preview.snapshot();
    assert.equal(view.truncatedBefore, false);
    assert.ok(wireBytes(view.messages) <= CLI_SESSION_BODY_MAX_BYTES);
    const probe = {
      epoch: EPOCH,
      snapshotId: '22222222-2222-4222-8222-222222222222',
      source: 'cursor-cli' as const,
      sessionId: '33333333-3333-4333-8333-333333333333',
      seq: 8,
      messages: view.messages,
    };
    assert.ok(wireBytes(probe) > CLI_FULL_MAX_BYTES);

    const mark = rig.events.length;
    rig.manager.snapshotForSync();
    const fulls = rig.events.slice(mark).filter(event => event.event === 'cli:full').map(event => event.payload);
    assert.equal(fulls.length, 1);
    const full = fulls[0];
    assert.ok(full);
    assert.equal(checkWireBudget(full, CLI_FULL_MAX_BYTES).ok, true);
    assert.equal(checkSyncWireBudget(fulls).ok, true);
    const parsed = cliFullSchema.safeParse(full);
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    assert.equal(full.truncatedBefore, true);
    assert.equal(full.firstRetainedFlatIndex, 1);
    const messages = full.messages as Array<{ id?: string; flatIndex?: number }>;
    assert.equal(messages.some(message => message.id === 'assistant:m0:0'), false);
    assert.equal(messages.at(-1)?.id, 'assistant:tail:0');
    assert.equal(messages[0]?.flatIndex, 1);
    client.finishPrompt();
    await flush();
    await rig.manager.close({ source: 'cursor-cli', sessionId });
  });

  it('单条顶格元素的 append 包落在 1 MiB 内', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    const mark = rig.events.length;
    client.emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'big',
      content: { type: 'text', text: 'x'.repeat(CLI_ELEMENT_MAX_BYTES) },
    });
    const append = rig.events.slice(mark).filter(event => event.event === 'cli:append').at(-1)?.payload;
    assert.ok(append);
    assert.equal(checkWireBudget(append, CLI_APPEND_MAX_BYTES).ok, true);
    const parsed = cliAppendSchema.safeParse(append);
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    const text = (append.messages as Array<{ text?: string }>)[0]?.text ?? '';
    assert.equal(text.endsWith('x'.repeat(64)), true);
    assert.ok(text.length < CLI_ELEMENT_MAX_BYTES);
    client.finishPrompt();
    await flush();
    await rig.manager.close({ source: 'cursor-cli', sessionId });
  });

  it('单条超长消息被缩短后保留尾部，并带上裁剪标记', async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    const original = 'x'.repeat(CLI_ELEMENT_MAX_BYTES);
    const mark = rig.events.length;
    client.emitUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'big',
      content: { type: 'text', text: original },
    });
    const append = rig.events.slice(mark).filter(event => event.event === 'cli:append').at(-1)?.payload;
    assert.ok(append);
    const message = (append.messages as Array<{ text?: string; flatIndex?: number }>)[0];
    const text = message?.text ?? '';
    assert.equal(checkWireBudget(append, CLI_APPEND_MAX_BYTES).ok, true);
    assert.equal(cliAppendSchema.safeParse(append).success, true);
    assert.ok(text.length < original.length);
    assert.equal(original.endsWith(text), true);
    assert.equal(append.truncatedBefore, true);
    assert.equal(append.firstRetainedFlatIndex, message?.flatIndex);
    client.finishPrompt();
    await flush();
    await rig.manager.close({ source: 'cursor-cli', sessionId });
  });

  it('四个顶满的 full 加上 snapshot 后仍不超过同步预算', { timeout: 180_000 }, async () => {
    const big = 'x'.repeat(CLI_ELEMENT_MAX_BYTES);
    const probeFull = (messages: unknown[]) => ({
      epoch: EPOCH,
      snapshotId: '22222222-2222-4222-8222-222222222222',
      source: 'cursor-cli' as const,
      sessionId: '33333333-3333-4333-8333-333333333333',
      seq: 8,
      messages,
    });
    const messagesFor = (tailLen: number) => {
      const preview = new AcpTimelineAssembler();
      for (let i = 0; i < 7; i += 1) {
        preview.apply({
          sessionUpdate: 'agent_message_chunk',
          messageId: `m${i}`,
          content: { type: 'text', text: big },
        });
      }
      preview.apply({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'tail',
        content: { type: 'text', text: 't'.repeat(tailLen) },
      });
      return preview.snapshot().messages;
    };
    let low = 1;
    let high = CLI_ELEMENT_MAX_BYTES;
    let tailLen = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (wireBytes(probeFull(messagesFor(mid))) <= CLI_FULL_MAX_BYTES) {
        tailLen = mid;
        low = mid + 1;
      }
      else {
        high = mid - 1;
      }
    }
    const probeMessages = messagesFor(tailLen);
    const oneFull = wireBytes(probeFull(probeMessages));
    assert.equal(oneFull, CLI_FULL_MAX_BYTES);
    assert.equal(oneFull * 4, CLI_SYNC_MAX_BYTES);

    const rig = createRig(cwd);
    const sessions = [];
    for (let i = 0; i < 4; i += 1)
      sessions.push(await boot(rig));
    for (const { client } of sessions) {
      for (let i = 0; i < 7; i += 1) {
        client.emitUpdate({
          sessionUpdate: 'agent_message_chunk',
          messageId: `m${i}`,
          content: { type: 'text', text: big },
        });
      }
      client.emitUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'tail',
        content: { type: 'text', text: 't'.repeat(tailLen) },
      });
    }
    const mark = rig.events.length;
    rig.manager.snapshotForSync();
    const emitted = rig.events.slice(mark);
    const snapshot = emitted.find(event => event.event === 'cli:snapshot')?.payload;
    const fulls = emitted.filter(event => event.event === 'cli:full').map(event => event.payload);
    assert.ok(snapshot);
    assert.equal(fulls.length, 4);
    assert.ok(wireBytes(snapshot) > 0);
    assert.equal(checkSyncWireBudget([snapshot, ...fulls]).ok, true);
    for (const full of fulls) {
      assert.equal(checkWireBudget(full, CLI_FULL_MAX_BYTES).ok, true);
      assert.equal(cliFullSchema.safeParse(full).success, true);
      const messages = full.messages as Array<{ id?: string }>;
      assert.equal(messages.at(-1)?.id, 'assistant:tail:0');
    }
    assert.equal(fulls.some(full => full.truncatedBefore === true), true);
    for (const { client, sessionId } of sessions) {
      client.finishPrompt();
      await rig.manager.close({ source: 'cursor-cli', sessionId });
    }
    await flush();
  });

  it('正文被裁头时 cli:append 带 truncatedBefore 和 firstRetainedFlatIndex', { timeout: 30_000 }, async () => {
    const rig = createRig(cwd);
    const { sessionId, client } = await boot(rig);
    const count = 2001;
    for (let i = 0; i < count; i += 1) {
      client.emitUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: `n${i}`,
        content: { type: 'text', text: String(i) },
      });
    }
    const append = rig.events.filter(event => event.event === 'cli:append').at(-1)?.payload;
    assert.ok(append);
    assert.equal(append.truncatedBefore, true);
    assert.equal(append.firstRetainedFlatIndex, 1);
    const parsed = cliAppendSchema.safeParse(append);
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    client.finishPrompt();
    await flush();
    await rig.manager.close({ source: 'cursor-cli', sessionId });
  });

  it('copies finished CodeBuddy jsonl turns the ACP session does not already show', async () => {
    const projects = await mkdtemp(path.join(tmpdir(), 'lifeline-cb-projects-'));
    const rig = createRig(cwd, undefined, projects);
    const file = path.join(projects, codebuddyProjectSlug(realpathSync(cwd)), `${PROVIDER_SESSION_ID}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({
      type: 'message',
      id: 'user-weather',
      role: 'user',
      content: [{ type: 'input_text', text: '今天天气怎么样' }],
      __codebuddyLocal: true,
    })}\n`);
    const cursor = await boot(rig, 'cursor-cli');
    const cursorFull = rig.events.filter(event => event.event === 'cli:full').at(-1)?.payload;
    assert.equal(JSON.stringify(cursorFull).includes('今天天气怎么样'), false);
    await rig.manager.close({ source: 'cursor-cli', sessionId: cursor.sessionId });

    const started = await boot(rig, 'codebuddy-cli');
    const full = cliFullSchema.parse(rig.events.filter(event => event.event === 'cli:full').at(-1)?.payload);
    assert.equal(full.messages.some(message => message.type === 'human' && message.text === '今天天气怎么样'), true);

    const admission = rig.manager.prompt({
      source: 'codebuddy-cli',
      sessionId: started.sessionId,
      text: '你好',
      clientMessageId: 'msg-echo',
    });
    assert.deepEqual(admission, { ok: true });
    appendFileSync(file, `${JSON.stringify({
      type: 'message',
      id: 'user-echo',
      role: 'user',
      content: [{ type: 'input_text', text: '你好' }],
    })}\n`);
    rig.manager.followExternalTranscripts();
    assert.equal(countText(rig, '你好'), 1);
    started.client.finishPrompt();
    await flush();
    rig.manager.followExternalTranscripts();
    assert.equal(countText(rig, '你好'), 1);

    appendFileSync(file, `${JSON.stringify({
      type: 'message',
      id: 'user-city',
      role: 'user',
      content: [{ type: 'input_text', text: '广州' }],
      __codebuddyLocal: true,
    })}\n`);
    rig.manager.followExternalTranscripts();
    const appended = cliAppendSchema.parse(rig.events.filter(event => event.event === 'cli:append').at(-1)?.payload);
    assert.equal(appended.messages.some(message => message.type === 'human' && message.text === '广州'), true);
    assertOnlyCliEvents(rig.events);
    await rig.manager.close({ source: 'codebuddy-cli', sessionId: started.sessionId });
    await rm(projects, { recursive: true, force: true });
  });

  it('does not reference the IDE session index, ledger events, or sqlite approvals', () => {
    const text = readFileSync(new URL('../packages/agent/src/cli-session-manager.ts', import.meta.url), 'utf8');
    assert.equal(text.includes('sessionIndexReporter'), false);
    assert.equal(text.includes('session:full'), false);
    assert.equal(text.includes('sessions:index'), false);
    assert.equal(text.includes('pendingApprovals'), false);
    assert.equal(text.includes('better-sqlite3'), false);
  });
});

function countText(rig: Rig, text: string): number {
  let count = 0;
  for (const event of rig.events) {
    if (event.event !== 'cli:full' && event.event !== 'cli:append')
      continue;
    const messages = event.payload.messages;
    if (!Array.isArray(messages))
      continue;
    for (const message of messages) {
      if (isRecord(message) && message.text === text)
        count += 1;
    }
  }
  return count;
}

function approvalIdOf(rig: Rig): string {
  const card = rig.events.filter(event => event.event === 'cli:approval').at(-1)?.payload.approval;
  if (!isRecord(card) || typeof card.approvalId !== 'string')
    throw new Error('missing approval');
  return card.approvalId;
}
