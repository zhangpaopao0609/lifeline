import type {
  CliAcpCapability,
  CliAppend,
  CliApprovalResolved,
  CliCapabilities,
  CliFull,
  CliPermissionResponsePayload,
  CliSessionCreated,
  CliSessionRemoved,
  CliStatus,
  CliUnavailableReason,
  CommandPayload,
  CommandResult,
} from '@lifeline/protocol';
import type { CDPBridge } from '../packages/agent/src/cdp/bridge.js';
import type { CommandTarget } from '../packages/agent/src/command-router.js';
import type { CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_COMMAND_EVENTS,
  assertCliApproval,
  assertCliSnapshot,
  assertCliStart,
  assertCliTarget,
  CLI_COMMAND_EVENTS,
  CLI_SOURCES,
  CLI_UNAVAILABLE_REASONS,
  COMMAND_ERROR_CODES,
  COMMAND_EVENTS,
  isCliSource,
  parseIde,
} from '@lifeline/protocol';
import {
  attachCommandHandlers,
  attachIdeCommandHandlers,
} from '../packages/agent/src/command-router.js';

const IDE_COMMAND_EVENTS = [
  'command:send_message',
  'command:approve',
  'command:approve_all',
  'command:reject',
  'command:stop',
  'command:switch_tab',
  'command:new_chat',
  'command:set_mode',
  'command:set_model',
  'command:get_model_options',
  'command:get_plan_full',
  'command:get_plan_model_options',
  'command:set_plan_model',
  'command:click_action',
  'command:switch_window',
] as const;

function throws(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    return true;
  });
}

describe('CliSource', () => {
  it('accepts the supported CLI sources', () => {
    assert.deepEqual(CLI_SOURCES, ['cursor-cli', 'codebuddy-cli', 'dsh-cli']);
    assert.equal(isCliSource('cursor-cli'), true);
    assert.equal(isCliSource('codebuddy-cli'), true);
    assert.equal(isCliSource('dsh-cli'), true);
    assert.equal(isCliSource('cursor'), false);
    assert.equal(isCliSource('codebuddy'), false);
    assert.equal(isCliSource(''), false);
    assert.equal(isCliSource(null), false);
    assert.equal(isCliSource(undefined), false);
  });
});

describe('CliTarget', () => {
  it('accepts a cli source and session id', () => {
    assert.deepEqual(assertCliTarget({
      kind: 'cli',
      source: 'cursor-cli',
      sessionId: 'sess-1',
    }), {
      kind: 'cli',
      source: 'cursor-cli',
      sessionId: 'sess-1',
    });
  });

  it('rejects a missing sessionId, an unknown source, and a non-cli kind', () => {
    throws(() => assertCliTarget({
      kind: 'cli',
      source: 'cursor-cli',
    }), /sessionId/);
    throws(() => assertCliTarget({
      kind: 'cli',
      source: 'cursor-cli',
      sessionId: '',
    }), /sessionId/);
    throws(() => assertCliTarget({
      kind: 'cli',
      source: 'cursor',
      sessionId: 'sess-1',
    }), /source/);
    throws(() => assertCliTarget({
      kind: 'cli',
      source: '',
      sessionId: 'sess-1',
    }), /source/);
    throws(() => assertCliTarget({
      kind: 'ide',
      source: 'cursor-cli',
      sessionId: 'sess-1',
    }), /kind/);
    throws(() => assertCliTarget({
      source: 'cursor-cli',
      sessionId: 'sess-1',
    }), /kind/);
    throws(() => assertCliTarget(null), /kind/);
  });
});

describe('command:cli_start', () => {
  it('requires an absolute cwd and keeps that path unchanged', () => {
    throws(() => assertCliStart({
      commandId: 'c1',
      source: 'cursor-cli',
      cwd: 'repo',
    }), /absolute/);
    throws(() => assertCliStart({
      commandId: 'c1',
      source: 'cursor-cli',
      cwd: './repo',
    }), /absolute/);
    throws(() => assertCliStart({
      commandId: 'c1',
      source: 'cursor-cli',
      cwd: '',
    }), /absolute/);

    const started = assertCliStart({
      commandId: 'c1',
      source: 'codebuddy-cli',
      cwd: '/tmp/lifeline/../keep',
      clientRequestId: 'req-1',
    });
    assert.equal(started.cwd, '/tmp/lifeline/../keep');
    assert.equal(started.clientRequestId, 'req-1');
    assert.equal(started.source, 'codebuddy-cli');
  });

  it('rejects an unknown source', () => {
    throws(() => assertCliStart({
      commandId: 'c1',
      source: 'cursor',
      cwd: '/tmp/work',
    }), /source/);
  });
});

describe('CliApproval', () => {
  it('requires optionId, keeps label text, and allows only four kinds', () => {
    const approval = assertCliApproval({
      approvalId: 'ap-1',
      sessionId: 'sess-1',
      title: 'Run command',
      state: 'pending',
      options: [
        { optionId: 'once', label: '  允许一次（原文）  ', kind: 'allow_once' },
        { optionId: 'always', label: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject', label: 'Reject', kind: 'reject_once' },
        { optionId: 'other', label: '???', kind: 'unknown' },
      ],
    });
    assert.equal(approval.options[0]?.label, '  允许一次（原文）  ');
    assert.deepEqual(Object.keys(approval).sort(), ['approvalId', 'options', 'sessionId', 'state', 'title']);
    assert.deepEqual(Object.keys(approval.options[0] ?? {}).sort(), ['kind', 'label', 'optionId']);
    assert.equal('selectorPath' in approval, false);
    assert.equal('selectorPath' in (approval.options[0] ?? {}), false);

    throws(() => assertCliApproval({
      approvalId: 'ap-1',
      sessionId: 'sess-1',
      title: 'Run command',
      state: 'pending',
      options: [{ label: 'Allow', kind: 'allow_once' }],
    }), /optionId/);
    throws(() => assertCliApproval({
      approvalId: 'ap-1',
      sessionId: 'sess-1',
      title: 'Run command',
      state: 'pending',
      options: [{ optionId: '', label: 'Allow', kind: 'allow_once' }],
    }), /optionId/);
    throws(() => assertCliApproval({
      approvalId: 'ap-1',
      sessionId: 'sess-1',
      title: 'Run command',
      state: 'pending',
      options: [{ optionId: 'once', label: 'Allow', kind: 'approve' }],
    }), /kind/);
    throws(() => assertCliApproval({
      approvalId: 'ap-1',
      sessionId: 'sess-1',
      title: 'Run command',
      state: 'pending',
      options: [{ optionId: 'once', label: 'Allow', kind: 'allow_once', selectorPath: '#ok' }],
    }), /selectorPath/);
  });
});

describe('CLI command events', () => {
  it('keeps the 15 IDE events and appends the CLI events', () => {
    assert.deepEqual(COMMAND_EVENTS, IDE_COMMAND_EVENTS);
    assert.equal(COMMAND_EVENTS.length, 15);
    assert.deepEqual(CLI_COMMAND_EVENTS, [
      'command:cli_start',
      'command:cli_catalog',
      'command:cli_model',
      'command:cli_thinking',
      'command:cli_close',
      'command:cli_permission_response',
    ]);
    assert.deepEqual(ALL_COMMAND_EVENTS, [...COMMAND_EVENTS, ...CLI_COMMAND_EVENTS]);
    for (const event of CLI_COMMAND_EVENTS)
      assert.equal((COMMAND_EVENTS as readonly string[]).includes(event), false);
  });

  it('lists wire error codes without interface-only statuses', () => {
    assert.deepEqual(COMMAND_ERROR_CODES, [
      'unsupported-platform',
      'invalid-cwd',
      'invalid-payload',
      'binary-missing',
      'binary-not-executable',
      'too-many-sessions',
      'unsupported-acp-version',
      'no-credential',
      'auth-rejected',
      'provider-timeout',
      'provider-error',
      'shutting-down',
      'cli-agent-incompatible',
      'wrong-target',
    ]);
    assert.equal((COMMAND_ERROR_CODES as readonly string[]).includes('busy'), false);
    assert.equal((COMMAND_ERROR_CODES as readonly string[]).includes('already-resolved'), false);
    assert.equal((COMMAND_ERROR_CODES as readonly string[]).includes('sync-error'), false);
  });
});

describe('cli capability types', () => {
  it('separates static registration from dynamic availability', () => {
    assert.deepEqual(CLI_UNAVAILABLE_REASONS, ['binary-missing', 'credential-required', 'error']);
    const unavailable: CliUnavailableReason = 'credential-required';
    const registered: CliAcpCapability = {
      protocolVersion: 1,
      platform: 'darwin',
      sources: [{ source: 'cursor-cli' }, { source: 'codebuddy-cli' }],
    };
    const dynamic: CliCapabilities = {
      epoch: 'epoch-1',
      platform: 'darwin',
      sources: [{
        source: 'cursor-cli',
        availability: unavailable,
        checkedAt: 1,
        detail: 'sign in',
      }],
    };
    assert.equal(registered.protocolVersion, 1);
    assert.equal(dynamic.sources[0]?.availability, 'credential-required');
    assert.equal(dynamic.sources[0]?.detail, 'sign in');
  });
});

describe('cli event payloads', () => {
  it('carries the design fields for session lifecycle events', () => {
    const created: CliSessionCreated = {
      epoch: 'epoch-1',
      source: 'cursor-cli',
      sessionId: 'sess-1',
      cwd: '/tmp/work',
      status: 'starting',
      seq: 0,
      originCommandId: 'c1',
      clientRequestId: 'req-1',
    };
    const full: CliFull = {
      epoch: 'epoch-1',
      snapshotId: 'snap-1',
      source: 'cursor-cli',
      sessionId: 'sess-1',
      seq: 0,
      messages: [],
    };
    const append: CliAppend = {
      epoch: 'epoch-1',
      source: 'cursor-cli',
      sessionId: 'sess-1',
      seq: 1,
      messages: [],
    };
    const status: CliStatus = {
      epoch: 'epoch-1',
      source: 'cursor-cli',
      sessionId: 'sess-1',
      status: 'idle',
      model: 'composer',
    };
    const resolved: CliApprovalResolved = {
      epoch: 'epoch-1',
      source: 'cursor-cli',
      sessionId: 'sess-1',
      approvalId: 'ap-1',
      resolution: 'cancelled',
    };
    const removed: CliSessionRemoved = {
      epoch: 'epoch-1',
      source: 'cursor-cli',
      sessionId: 'sess-1',
    };
    const response: CliPermissionResponsePayload = {
      commandId: 'c1',
      target: { kind: 'cli', source: 'codebuddy-cli', sessionId: 'sess-1' },
      approvalId: 'ap-1',
      response: { outcome: 'cancelled' },
    };
    assert.equal(created.seq, 0);
    assert.equal(full.messages.length, 0);
    assert.equal(append.seq, 1);
    assert.equal(status.model, 'composer');
    assert.equal(resolved.resolution, 'cancelled');
    assert.equal(removed.sessionId, 'sess-1');
    assert.equal(response.response.outcome, 'cancelled');
  });
});

describe('cli:snapshot', () => {
  const session = (sessionId: string, patch: Record<string, unknown> = {}) => ({
    source: 'cursor-cli',
    sessionId,
    cwd: '/tmp/work',
    status: 'idle',
    seq: 0,
    approvals: [],
    ...patch,
  });

  it('accepts an empty session list', () => {
    assert.deepEqual(assertCliSnapshot({
      epoch: 'epoch-1',
      snapshotId: 'snap-1',
      sessions: [],
    }), {
      epoch: 'epoch-1',
      snapshotId: 'snap-1',
      sessions: [],
    });
  });

  it('keeps a model catalog on a snapshot session', () => {
    const catalog = {
      models: [
        { id: 'glm-5.2', label: 'GLM 5.2' },
        { id: 'kimi-k3', label: 'Kimi K3' },
      ],
      currentModelId: 'glm-5.2',
      thinking: {
        current: 'high',
        levels: [
          { value: 'high', label: 'High' },
          { value: 'max', label: 'Max' },
        ],
      },
    };
    const parsed = assertCliSnapshot({
      epoch: 'epoch-1',
      snapshotId: 'snap-1',
      sessions: [session('s1', { model: 'GLM 5.2', catalog })],
    });
    assert.deepEqual(parsed.sessions[0]?.catalog, catalog);
    assert.equal(parsed.sessions[0]?.model, 'GLM 5.2');
  });

  it('accepts more than four sessions', () => {
    const five = assertCliSnapshot({
      epoch: 'epoch-1',
      snapshotId: 'snap-1',
      sessions: ['s1', 's2', 's3', 's4', 's5'].map(id => session(id)),
    });
    assert.equal(five.sessions.length, 5);
  });

  it('rejects a session missing seq or status', () => {
    const { seq: _seq, ...noSeq } = session('s1');
    const { status: _status, ...noStatus } = session('s1');
    throws(() => assertCliSnapshot({
      epoch: 'epoch-1',
      snapshotId: 'snap-1',
      sessions: [noSeq],
    }), /seq/);
    throws(() => assertCliSnapshot({
      epoch: 'epoch-1',
      snapshotId: 'snap-1',
      sessions: [noStatus],
    }), /status/);
  });
});

describe('parseIde regression', () => {
  it('still falls back when the raw value is a CLI source', () => {
    assert.equal(parseIde('cursor-cli'), 'cursor');
  });
});

function createBus(): {
  events: string[];
  on: (event: string, handler: (payload: CommandPayload) => void) => void;
  emit: (event: string, payload: CommandPayload) => Promise<void>;
} {
  const handlers = new Map<string, Array<(payload: CommandPayload) => unknown>>();
  const events: string[] = [];
  return {
    events,
    on(event, handler) {
      events.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async emit(event, payload) {
      const list = handlers.get(event) ?? [];
      await Promise.all(list.map(handler => Promise.resolve(handler(payload))));
    },
  };
}

function countingExecutor(): { calls: string[]; executor: CommandExecutor } {
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
  return { calls, executor };
}

function guardedTarget(results: CommandResult[], executor: CommandExecutor): {
  target: CommandTarget;
  bridgeTouches: () => number;
  pauses: () => number;
} {
  let bridgeTouches = 0;
  let pauses = 0;
  const bridge = new Proxy({} as CDPBridge, {
    get(_target, prop) {
      if (prop === 'then')
        return undefined;
      bridgeTouches += 1;
      return () => {
        bridgeTouches += 1;
        return Promise.resolve();
      };
    },
  });
  return {
    target: {
      commandExecutor: executor,
      cdpBridge: bridge,
      emitResult: (result) => {
        results.push(result);
      },
      pauseLive: () => {
        pauses += 1;
      },
    },
    bridgeTouches: () => bridgeTouches,
    pauses: () => pauses,
  };
}

function cliPayload(event: 'send_message' | 'stop', patch: Partial<CommandPayload> = {}): CommandPayload {
  return {
    commandId: `cmd-${event}`,
    type: event,
    text: event === 'send_message' ? 'hello' : undefined,
    windowId: 'win-should-not-switch',
    tabTitle: 'should-not-land',
    ide: 'codebuddy',
    target: {
      kind: 'cli',
      source: 'cursor-cli',
      sessionId: 'sess-1',
    },
    ...patch,
  };
}

describe('IDE command router CLI guard', () => {
  it('registers only the IDE command events', () => {
    const single = createBus();
    const { target } = guardedTarget([], countingExecutor().executor);
    attachCommandHandlers(single.on, target);
    assert.deepEqual(single.events, [...COMMAND_EVENTS]);

    const multi = createBus();
    attachIdeCommandHandlers(multi.on, { cursor: target });
    assert.deepEqual(multi.events, [...COMMAND_EVENTS]);
  });

  const attachments: Array<[
    string,
    (on: ReturnType<typeof createBus>['on'], target: CommandTarget) => void,
  ]> = [
    ['attachCommandHandlers', (on, target) => {
      attachCommandHandlers(on, target);
    }],
    ['attachIdeCommandHandlers', (on, target) => {
      attachIdeCommandHandlers(on, { cursor: target });
    }],
  ];
  for (const [name, attachTo] of attachments) {
    for (const event of ['send_message', 'stop'] as const) {
      it(`${name} rejects target.kind cli ${event} before CDP`, async () => {
        const results: CommandResult[] = [];
        const executor = countingExecutor();
        const guard = guardedTarget(results, executor.executor);
        const bus = createBus();
        attachTo(bus.on, guard.target);

        await bus.emit(`command:${event}`, cliPayload(event));

        assert.equal(executor.calls.length, 0);
        assert.equal(guard.bridgeTouches(), 0);
        assert.equal(guard.pauses(), 0);
        assert.deepEqual(results, [{
          commandId: `cmd-${event}`,
          ok: false,
          error: 'wrong-target',
          errorCode: 'wrong-target',
        }]);
      });
    }
  }

  it('rejects a cli target before choosing an IDE slot', async () => {
    const results: CommandResult[] = [];
    const cursor = countingExecutor();
    const guard = guardedTarget(results, cursor.executor);
    const bus = createBus();
    attachIdeCommandHandlers(bus.on, { cursor: guard.target });

    await bus.emit('command:send_message', cliPayload('send_message', { ide: 'codebuddy' }));

    assert.equal(cursor.calls.length, 0);
    assert.equal(guard.bridgeTouches(), 0);
    assert.equal(results[0]?.errorCode, 'wrong-target');
    assert.notEqual(results[0]?.error, 'IDE unavailable: codebuddy');
  });

  it('keeps an IDE send on the IDE path when target is absent or not cli', async () => {
    const results: CommandResult[] = [];
    const executor = countingExecutor();
    const guard = guardedTarget(results, executor.executor);
    const bus = createBus();
    attachCommandHandlers(bus.on, guard.target);

    await bus.emit('command:send_message', {
      commandId: 'ide-1',
      text: 'hello',
    });
    await bus.emit('command:send_message', {
      commandId: 'ide-2',
      text: 'hello',
      ide: 'cursor-cli' as CommandPayload['ide'],
      target: { kind: 'ide' } as CommandPayload['target'],
    });

    assert.deepEqual(executor.calls, ['sendMessage', 'sendMessage']);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, true);
    assert.equal(results[1]?.errorCode, undefined);
  });
});
