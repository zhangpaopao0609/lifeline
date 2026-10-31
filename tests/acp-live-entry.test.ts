import type { CliCapabilities } from '@lifeline/protocol';
import type { ReadinessClient } from '../packages/agent/src/drivers/acp/readiness.js';
import type { AcpClientEvent } from '../packages/agent/src/drivers/acp/types.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { JsonlRpcRemoteError } from '../packages/agent/src/drivers/acp/jsonl-rpc.js';
import { attachLiveCliListeners, buildLiveAcpClientOptions, createLiveCliEntry } from '../packages/agent/src/drivers/acp/live-entry.js';
import { writeCliSessionLedger } from '../packages/agent/src/drivers/acp/session-ledger.js';
import { deliverServerCommand } from '../packages/agent/src/server-inbound.js';

const FAKE_KEY = 'llk_fake_not_a_real_secret';
const EPOCH = '11111111-1111-4111-8111-111111111111';

describe('live ACP entry', () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs)
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lifeline-live-acp-'));
    dirs.push(dir);
    return dir;
  }

  it('returns unsupported-platform before constructing a client', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      let constructions = 0;
      const entry = createLiveCliEntry({
        epoch: EPOCH,
        platform,
        env: {
          LIFELINE_LINUX_CDP: '1',
          LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
          AGENT_TOKEN: 'agent-token',
          REMOTE_URL: 'https://lifeline.example',
        },
        apiKey: FAKE_KEY,
        emit: () => {},
        construct: () => {
          constructions += 1;
          return fakeSession();
        },
      });
      const result = await entry.start({ source: 'cursor-cli', cwd: tempDir() });
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.equal(result.errorCode, 'unsupported-platform');
      assert.equal(constructions, 0);
      assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
    }
  });

  it('reloads a recorded session through the auth wrapper', async () => {
    const cwd = tempDir();
    const ledger = join(cwd, 'cli-sessions.json');
    const providerSessionId = '01a181b5-572f-7a9e-9b98-66062a6b1546';
    writeCliSessionLedger(ledger, [{ source: 'codebuddy-cli', cwd, providerSessionId }]);
    let loaded: { cwd: string; sessionId: string } | undefined;
    const events: string[] = [];
    const entry = createLiveCliEntry({
      epoch: EPOCH,
      platform: 'darwin',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        LIFELINE_CODEBUDDY_CLI: '/opt/homebrew/bin/codebuddy',
      },
      apiKey: FAKE_KEY,
      ledgerPath: ledger,
      emit: event => events.push(event),
      construct: () => ({
        async start() {},
        async initialize() {
          return { protocolVersion: 1 };
        },
        async sessionNew() {
          return { sessionId: 'unused', models: [], modes: [] };
        },
        async sessionLoad(input) {
          loaded = input;
          return { sessionId: input.sessionId, models: [], modes: [] };
        },
        async prompt() {
          return { stopReason: 'end_turn' };
        },
        async cancel() {},
        async close() {},
      }),
    });
    await entry.manager.restore();
    assert.deepEqual(loaded, { cwd: realpathSync(cwd), sessionId: providerSessionId });
    assert.equal(events.includes('cli:session-created'), true);
    assert.equal(events.includes('cli:full'), true);
    await entry.manager.closeAll();
  });

  it('builds absolute command and child env without starting AcpClient', () => {
    const lines: string[] = [];
    const restore = captureConsole(lines);
    try {
      const codebuddy = buildLiveAcpClientOptions({
        source: 'codebuddy-cli',
        cwd: '/tmp/work',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/Users/me',
          http_proxy: 'http://127.0.0.1:9',
          AGENT_TOKEN: 'agent-token',
          REMOTE_URL: 'https://lifeline.example',
          LIFELINE_CODEBUDDY_CLI: '/opt/homebrew/bin/codebuddy',
        },
        apiKey: FAKE_KEY,
        environment: 'ioa',
      });
      assert.equal(codebuddy.command, '/opt/homebrew/bin/codebuddy');
      assert.deepEqual(codebuddy.args, ['--acp']);
      assert.equal(codebuddy.env?.PATH, '/opt/homebrew/bin:/usr/bin:/bin');
      assert.equal(codebuddy.env?.HOME, '/Users/me');
      assert.equal(codebuddy.env?.http_proxy, 'http://127.0.0.1:9');
      assert.equal(codebuddy.env?.AGENT_TOKEN, undefined);
      assert.equal(codebuddy.env?.REMOTE_URL, undefined);
      assert.equal(codebuddy.env?.CODEBUDDY_API_KEY === FAKE_KEY, true);
      assert.equal(codebuddy.env?.CODEBUDDY_INTERNET_ENVIRONMENT, 'ioa');

      const cursor = buildLiveAcpClientOptions({
        source: 'cursor-cli',
        cwd: '/tmp/work',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/Users/me',
          AGENT_TOKEN: 'agent-token',
          REMOTE_URL: 'https://lifeline.example',
          LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
          CODEBUDDY_API_KEY: FAKE_KEY,
        },
        apiKey: FAKE_KEY,
      });
      assert.equal(cursor.command, '/opt/homebrew/bin/cursor-agent');
      assert.deepEqual(cursor.args, ['acp']);
      const chosen = buildLiveAcpClientOptions({
        source: 'cursor-cli',
        cwd: '/tmp/work',
        modelId: 'grok-4.7-high',
        env: {
          LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
        },
      });
      assert.deepEqual(chosen.args, ['--model', 'grok-4.7-high', 'acp']);
      const rejected = buildLiveAcpClientOptions({
        source: 'cursor-cli',
        cwd: '/tmp/work',
        modelId: '--force',
        env: {
          LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
        },
      });
      assert.deepEqual(rejected.args, ['acp']);
      assert.equal(cursor.env?.AGENT_TOKEN, undefined);
      assert.equal(cursor.env?.REMOTE_URL, undefined);
      assert.equal(cursor.env?.CODEBUDDY_API_KEY, undefined);
      assert.equal(JSON.stringify(cursor.env).includes(FAKE_KEY), false);
    }
    finally {
      restore();
    }
    assert.equal(lines.join('\n').includes(FAKE_KEY), false);
  });

  it('probes unknown, then reports failure and success without a second probe session', async () => {
    const times = [100, 100, 50, 200, 180];
    let clock = 0;
    const reports: CliCapabilities[] = [];
    let constructions = 0;
    let probeOpens = 0;
    let probeSessionNew = 0;
    let startSessionNew = 0;
    let attempt = 0;
    const entry = createLiveCliEntry({
      epoch: EPOCH,
      platform: 'darwin',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        AGENT_TOKEN: 'agent-token',
        REMOTE_URL: 'https://lifeline.example',
        LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
      },
      apiKey: FAKE_KEY,
      now: () => times[clock++] ?? 0,
      emit: (event, payload) => {
        if (event === 'cli:capabilities')
          reports.push(payload as CliCapabilities);
      },
      probeOpen: () => {
        probeOpens += 1;
        return probeClient(() => {
          probeSessionNew += 1;
        });
      },
      construct: (options) => {
        constructions += 1;
        assert.equal(options.command, '/opt/homebrew/bin/cursor-agent');
        assert.equal(options.env?.AGENT_TOKEN, undefined);
        assert.equal(options.env?.REMOTE_URL, undefined);
        assert.equal(JSON.stringify(options.env).includes(FAKE_KEY), false);
        const fail = attempt === 0;
        attempt += 1;
        return fakeSession(() => {
          startSessionNew += 1;
        }, fail);
      },
    });

    await entry.probe('cursor-cli');
    assert.equal(probeOpens, 1);
    assert.equal(probeSessionNew, 0);
    assert.equal(constructions, 0);

    const cwd = tempDir();
    const failed = await entry.start({ source: 'cursor-cli', cwd });
    assert.equal(failed.ok, false);
    assert.equal(probeOpens, 1);
    assert.equal(constructions, 1);
    assert.equal(startSessionNew, 0);

    const started = await entry.start({ source: 'cursor-cli', cwd });
    assert.equal(started.ok, true);
    assert.equal(probeOpens, 1);
    assert.equal(constructions, 2);
    assert.equal(startSessionNew, 1);
    assert.equal(probeSessionNew, 0);

    assert.equal(reports.length, 5);
    assert.equal(reports[0]?.sources[0]?.availability, 'unknown');
    assert.equal(reports[1]?.sources[0]?.availability, 'unknown');
    assert.notEqual(reports[2]?.sources[0]?.availability, 'ready');
    assert.equal(reports[3]?.sources[0]?.availability, 'unknown');
    assert.equal(reports[4]?.sources[0]?.availability, 'ready');
    assert.deepEqual(reports.map(report => report.sources[0]?.checkedAt), [100, 100, 100, 200, 200]);
    assert.equal(JSON.stringify(reports).includes(FAKE_KEY), false);
    for (const report of reports)
      assert.equal((report.sources[0]?.detail ?? '').includes('凭据已验证'), false);

    if (!started.ok)
      return;
    await entry.manager.close({ source: 'cursor-cli', sessionId: started.data.sessionId });
    assert.equal(reports.at(-1)?.sources[0]?.availability, 'unknown');
  });

  it('keeps the agent entry off a direct AcpClient construction', () => {
    const source = readFileSync(new URL('../packages/agent/src/index.ts', import.meta.url), 'utf8');
    assert.equal(source.includes('new AcpClient'), false);
    assert.equal(source.includes('createLiveCliEntry'), true);
    assert.equal(source.includes('canControlIde'), true);
    const liveAt = source.indexOf('attachLiveCliListeners(');
    const ideAt = source.indexOf('attachIdeCommandHandlers(');
    assert.equal(liveAt >= 0 && ideAt > liveAt, true);
  });

  it('emits CLI results before a later wrong-target listener', async () => {
    const emitter = new EventEmitter();
    let promptStarted = false;
    let cancelStarted = false;
    let closed = false;
    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let onEvent: ((event: AcpClientEvent) => void) | undefined;
    const approvals: string[] = [];
    const entry = createLiveCliEntry({
      epoch: EPOCH,
      platform: 'darwin',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        LIFELINE_CURSOR_CLI: '/opt/homebrew/bin/cursor-agent',
      },
      emit: (event, payload) => {
        if (event === 'cli:approval') {
          const approval = (payload as { approval?: { approvalId?: string } }).approval;
          if (approval?.approvalId)
            approvals.push(approval.approvalId);
        }
        emitter.emit(event, payload);
      },
      construct: (options) => {
        onEvent = options.onEvent;
        return {
          async start() {},
          async initialize() {
            return { protocolVersion: 1 };
          },
          async sessionNew() {
            return { sessionId: 'prov-1', models: [], modes: [] };
          },
          prompt() {
            promptStarted = true;
            return new Promise(() => {});
          },
          cancel() {
            cancelStarted = true;
            return cancelGate;
          },
          async close() {
            closed = true;
          },
        };
      },
    });
    const started = await entry.start({ source: 'cursor-cli', cwd: tempDir() });
    assert.equal(started.ok, true);
    if (!started.ok)
      return;
    const sessionId = started.data.sessionId;
    const target = { kind: 'cli' as const, source: 'cursor-cli' as const, sessionId };

    attachLiveCliListeners((event, handler) => {
      emitter.on(event, handler);
    }, entry);
    for (const event of ['command:send_message', 'command:stop'] as const) {
      emitter.on(event, (payload: { commandId?: string; target?: { kind?: string } }) => {
        if (payload.target?.kind !== 'cli')
          return;
        emitter.emit('command:result', {
          commandId: payload.commandId ?? '',
          ok: false,
          error: 'wrong-target',
          errorCode: 'wrong-target',
        });
      });
    }
    const first = new Map<string, { ok: boolean; error?: string; errorCode?: string; data?: unknown }>();
    emitter.on('command:result', (result: { commandId?: string; ok: boolean; error?: string; errorCode?: string; data?: unknown }) => {
      const commandId = result.commandId ?? '';
      if (!first.has(commandId))
        first.set(commandId, result);
    });

    onEvent?.({
      type: 'permission',
      raw: {
        toolCall: { title: 'npm test' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow-once' }],
      },
      respond: async () => ({ ok: true }),
    });
    const approvalId = approvals[0] ?? '';
    assert.equal(approvalId.length > 0, true);
    emitter.emit('command:cli_permission_response', {
      commandId: 'perm-1',
      target,
      approvalId,
      response: { outcome: 'selected', optionId: 'allow-once' },
    });
    const allowed = await waitFor(first, 'perm-1');
    assert.equal(allowed?.ok, true);
    emitter.emit('command:cli_permission_response', {
      commandId: 'perm-2',
      target,
      approvalId,
      response: { outcome: 'selected', optionId: 'allow-once' },
    });
    const again = await waitFor(first, 'perm-2');
    assert.equal(again?.ok, false);
    assert.equal(again?.errorCode, undefined);
    assert.equal(uiState(again), 'already-resolved');

    emitter.emit('command:send_message', {
      commandId: 'msg-1',
      target,
      text: 'hello',
      clientMessageId: 'client-1',
    });
    assert.equal(first.get('msg-1')?.ok, true);
    assert.notEqual(first.get('msg-1')?.errorCode, 'wrong-target');
    assert.equal(promptStarted, true);

    emitter.emit('command:stop', { commandId: 'stop-1', target });
    assert.equal(first.get('stop-1')?.ok, true);
    assert.notEqual(first.get('stop-1')?.errorCode, 'wrong-target');
    assert.equal(cancelStarted, true);

    emitter.emit('command:send_message', {
      commandId: 'bare-1',
      text: 'no target',
      clientMessageId: 'client-2',
    });
    emitter.emit('command:send_message', {
      commandId: 'ide-1',
      target: { kind: 'ide', source: 'cursor-cli', sessionId },
      text: 'ide',
      clientMessageId: 'client-3',
    });
    assert.equal(first.has('bare-1'), false);
    assert.equal(first.has('ide-1'), false);

    releaseCancel?.();
    emitter.emit('command:cli_close', { commandId: 'close-1', target });
    const closedResult = await waitFor(first, 'close-1');
    assert.equal(closedResult?.ok, true);
    assert.equal(closed, true);
  });

  it('keeps every provider row when a later capabilities report is emitted', async () => {
    const reports: CliCapabilities[] = [];
    let probeSessions = 0;
    const entry = createLiveCliEntry({
      epoch: EPOCH,
      platform: 'darwin',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        LIFELINE_CODEBUDDY_CLI: '/opt/homebrew/bin/codebuddy',
      },
      emit: (event, payload) => {
        if (event === 'cli:capabilities')
          reports.push(payload as CliCapabilities);
      },
      probeOpen: () => ({
        async start() {},
        async initialize() {
          return { protocolVersion: 1 };
        },
        async sessionNew() {
          probeSessions += 1;
          return { sessionId: 'probe-should-not' };
        },
        async close() {},
      }),
      construct: () => {
        throw new Error('boom');
      },
    });

    await entry.probe('cursor-cli');
    const cursor = sourceRow(reports.at(-1), 'cursor-cli');
    assert.equal(cursor?.availability, 'binary-missing');

    await entry.probe('codebuddy-cli');
    const combined = reports.at(-1);
    assert.equal(sourceRow(combined, 'cursor-cli')?.availability, 'binary-missing');
    assert.equal(sourceRow(combined, 'cursor-cli')?.checkedAt, cursor?.checkedAt);
    assert.equal(sourceRow(combined, 'codebuddy-cli')?.availability, 'unknown');
    assert.equal(probeSessions, 0);

    const before = reports.length;
    const pending = entry.start({ source: 'codebuddy-cli', cwd: tempDir() });
    const pre = reports.at(-1);
    assert.equal(reports.length, before + 1);
    assert.equal(sourceRow(pre, 'cursor-cli')?.availability, 'binary-missing');
    assert.equal(sourceRow(pre, 'codebuddy-cli')?.availability, 'unknown');
    const started = await pending;
    assert.equal(started.ok, false);
    const after = reports.at(-1);
    assert.equal(sourceRow(after, 'cursor-cli')?.availability, 'binary-missing');
    assert.equal(sourceRow(after, 'cursor-cli')?.checkedAt, cursor?.checkedAt);
  });

  it('classifies live start 401 and 403 from the child env key', async () => {
    const lines: string[] = [];
    const restore = captureConsole(lines);
    try {
      const withKey = await failLiveStart({
        apiKey: FAKE_KEY,
        source: 'codebuddy-cli',
        command: '/opt/homebrew/bin/codebuddy',
        rpcCode: 401,
      });
      assert.equal(withKey.result.ok, false);
      if (!withKey.result.ok)
        assert.equal(withKey.result.errorCode, 'auth-rejected');
      assert.equal(sourceRow(withKey.reports.at(-1), 'codebuddy-cli')?.availability, 'credential-required');
      assert.equal(withKey.sessionNew, 0);

      const withoutKey = await failLiveStart({
        source: 'codebuddy-cli',
        command: '/opt/homebrew/bin/codebuddy',
        rpcCode: 403,
      });
      assert.equal(withoutKey.result.ok, false);
      if (!withoutKey.result.ok)
        assert.equal(withoutKey.result.errorCode, 'no-credential');
      assert.equal(sourceRow(withoutKey.reports.at(-1), 'codebuddy-cli')?.availability, 'credential-required');

      const cursor = await failLiveStart({
        apiKey: FAKE_KEY,
        source: 'cursor-cli',
        command: '/opt/homebrew/bin/cursor-agent',
        rpcCode: 401,
      });
      assert.equal(cursor.result.ok, false);
      if (!cursor.result.ok)
        assert.equal(cursor.result.errorCode, 'no-credential');
      assert.equal(sourceRow(cursor.reports.at(-1), 'cursor-cli')?.availability, 'credential-required');

      const other = await failLiveStart({
        apiKey: FAKE_KEY,
        source: 'codebuddy-cli',
        command: '/opt/homebrew/bin/codebuddy',
        rpcCode: 500,
      });
      assert.equal(other.result.ok, false);
      if (!other.result.ok)
        assert.equal(other.result.errorCode, 'provider-error');
      assert.equal(sourceRow(other.reports.at(-1), 'codebuddy-cli')?.availability, 'error');

      const leaked = JSON.stringify([withKey, withoutKey, cursor, other]);
      assert.equal(leaked.includes(FAKE_KEY), false);
      assert.equal(leaked.includes('upstream-marker'), false);
    }
    finally {
      restore();
    }
    assert.equal(lines.join('\n').includes(FAKE_KEY), false);
    assert.equal(lines.join('\n').includes('upstream-marker'), false);
  });
});

function sourceRow(report: CliCapabilities | undefined, source: string): CliCapabilities['sources'][number] | undefined {
  return report?.sources.find(row => row.source === source);
}

async function failLiveStart(input: {
  source: 'cursor-cli' | 'codebuddy-cli';
  command: string;
  rpcCode: number;
  apiKey?: string;
}): Promise<{
  result: Awaited<ReturnType<ReturnType<typeof createLiveCliEntry>['start']>>;
  reports: CliCapabilities[];
  sessionNew: number;
}> {
  const reports: CliCapabilities[] = [];
  let sessionNew = 0;
  const envName = input.source === 'cursor-cli' ? 'LIFELINE_CURSOR_CLI' : 'LIFELINE_CODEBUDDY_CLI';
  const entry = createLiveCliEntry({
    epoch: EPOCH,
    platform: 'darwin',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      [envName]: input.command,
    },
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    emit: (event, payload) => {
      if (event === 'cli:capabilities')
        reports.push(payload as CliCapabilities);
    },
    construct: () => ({
      async start() {},
      async initialize() {
        throw new JsonlRpcRemoteError(input.rpcCode, `upstream-marker ${FAKE_KEY}`);
      },
      async sessionNew() {
        sessionNew += 1;
        return { sessionId: 'prov-1', models: [], modes: [] };
      },
      async prompt() {
        return { stopReason: 'end_turn' };
      },
      async cancel() {},
      async close() {},
    }),
  });
  const cwd = mkdtempSync(join(tmpdir(), 'lifeline-live-auth-'));
  try {
    const result = await entry.start({ source: input.source, cwd });
    return { result, reports, sessionNew };
  }
  finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function waitFor<T>(map: Map<string, T>, commandId: string): Promise<T | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = map.get(commandId);
    if (found)
      return found;
    await new Promise(resolve => setImmediate(resolve));
  }
  return map.get(commandId);
}

function uiState(result: { error?: string; data?: unknown } | undefined): string | undefined {
  const data = result?.data;
  if (data && typeof data === 'object' && 'state' in data && typeof data.state === 'string')
    return data.state;
  return result?.error;
}

function fakeSession(onSessionNew?: () => void, fail = false) {
  return {
    async start() {},
    async initialize() {
      if (fail)
        throw new Error('boom');
      return { protocolVersion: 1 };
    },
    async sessionNew() {
      onSessionNew?.();
      return { sessionId: 'prov-1', models: [], modes: [] };
    },
    async prompt() {
      return { stopReason: 'end_turn' };
    },
    async cancel() {},
    async close() {},
  };
}

function probeClient(onSessionNew: () => void): ReadinessClient {
  return {
    async start() {},
    async initialize() {
      return { protocolVersion: 1 };
    },
    async sessionNew() {
      onSessionNew();
      return { sessionId: 'probe-should-not' };
    },
    async close() {},
  };
}

describe('server command gate', () => {
  const target = () => {
    const calls: string[] = [];
    return {
      calls,
      start() {
        calls.push('start');
      },
      sync() {
        calls.push('sync');
      },
      parseIde() {
        calls.push('parseIde');
      },
    };
  };

  it('rejects a cli_start with a relative cwd and does not call the session manager', () => {
    const sink = target();
    deliverServerCommand('command:cli_start', {
      commandId: 'cmd-1',
      source: 'cursor-cli',
      cwd: 'relative/work',
    }, sink);
    assert.deepEqual(sink.calls, []);
  });

  it('accepts the cli:sync payload the server emits', () => {
    // agent-hub emitCliSync calls socket.emit('cli:sync') with no fields.
    const missing = target();
    deliverServerCommand('cli:sync', undefined, missing);
    const empty = target();
    deliverServerCommand('cli:sync', {}, empty);
    assert.deepEqual(missing.calls, ['sync']);
    assert.deepEqual(empty.calls, ['sync']);
  });
});

function captureConsole(lines: string[]): () => void {
  const methods = ['log', 'info', 'warn', 'error'] as const;
  const previous = methods.map(method => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map(arg => typeof arg === 'string' ? arg : '').join(' '));
    };
  }
  return () => {
    for (let index = 0; index < methods.length; index += 1)
      console[methods[index]!] = previous[index]!;
  };
}
