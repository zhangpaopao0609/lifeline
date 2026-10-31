import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACP_LINE_MAX_BYTES,
  ACP_STDERR_MAX_BYTES,
  agentRegisterSchema,
  chatElementSchema,
  checkSyncWireBudget,
  checkWireBudget,
  CLI_APPEND_MAX_BYTES,
  CLI_APPEND_MAX_ELEMENTS,
  CLI_APPROVAL_OPTION_LIMIT,
  CLI_ELEMENT_MAX_BYTES,
  CLI_FULL_MAX_BYTES,
  CLI_SESSION_BODY_MAX_BYTES,
  CLI_SESSION_BODY_MAX_ELEMENTS,
  CLI_SNAPSHOT_APPROVAL_LIMIT,
  CLI_SNAPSHOT_MAX_BYTES,
  CLI_SYNC_MAX_BYTES,
  cliAppendSchema,
  cliFullSchema,
  cliSnapshotSchema,
  cliStatusSchema,
  COMMAND_EVENTS,
  commandEventSchema,
  commandPayloadSchema,
  validateInbound,
  wireBytes,
} from '@lifeline/protocol';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_A = '33333333-3333-4333-8333-333333333333';

function sessionId(n: number): string {
  return `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
}

function approvalId(n: number): string {
  return `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
}

function option(index = 0, label = 'Allow') {
  return { optionId: `opt-${index}`, label, kind: 'allow_once' as const };
}

function approval(options: ReturnType<typeof option>[], index = 0) {
  return {
    approvalId: approvalId(index),
    sessionId: SESSION_A,
    title: 'Run command',
    state: 'pending' as const,
    options,
  };
}

function snapshotSession(overrides: Record<string, unknown> = {}) {
  return {
    source: 'cursor-cli' as const,
    sessionId: SESSION_A,
    cwd: '/tmp/work',
    status: 'idle' as const,
    seq: 0,
    approvals: [],
    ...overrides,
  };
}

function snapshot(sessions: unknown[]) {
  return { epoch: EPOCH, snapshotId: SNAPSHOT_ID, sessions };
}

function appendEnvelope(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    epoch: EPOCH,
    source: 'cursor-cli' as const,
    sessionId: SESSION_A,
    seq: 1,
    messages,
    ...overrides,
  };
}

function fullEnvelope(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    epoch: EPOCH,
    snapshotId: SNAPSHOT_ID,
    source: 'codebuddy-cli' as const,
    sessionId: SESSION_A,
    seq: 0,
    messages,
    ...overrides,
  };
}

function shallow(overrides: Record<string, unknown> = {}) {
  return { id: 'm1', type: 'human', flatIndex: 0, ...overrides };
}

describe('wire byte budgets', () => {
  it('exports the design budgets and the controller caps', () => {
    const mib = 1024 * 1024;
    assert.equal(CLI_ELEMENT_MAX_BYTES, mib);
    assert.equal(CLI_APPEND_MAX_ELEMENTS, 256);
    assert.equal(CLI_APPEND_MAX_BYTES, mib);
    assert.equal(CLI_FULL_MAX_BYTES, 8 * mib);
    assert.equal(CLI_SNAPSHOT_MAX_BYTES, 256 * 1024);
    assert.equal(CLI_SESSION_BODY_MAX_ELEMENTS, 2000);
    assert.equal(CLI_SESSION_BODY_MAX_BYTES, 8 * mib);
    assert.equal(CLI_SYNC_MAX_BYTES, 32 * mib);
    assert.equal(ACP_LINE_MAX_BYTES, 8 * mib);
    assert.equal(ACP_STDERR_MAX_BYTES, 64 * 1024);
    assert.equal(CLI_APPROVAL_OPTION_LIMIT, 16);
    assert.equal(CLI_SNAPSHOT_APPROVAL_LIMIT, 32);
  });

  it('counts utf8 wire bytes of the whole payload', () => {
    const ascii = { text: 'a' };
    const han = { text: '你' };
    assert.equal(wireBytes(ascii), Buffer.byteLength(JSON.stringify(ascii), 'utf8'));
    assert.equal(wireBytes(han) - wireBytes(ascii), 2);
  });

  it('returns an error when wire bytes exceed the budget and accepts the boundary', () => {
    const payload = { text: 'abcd' };
    const size = wireBytes(payload);
    assert.deepEqual(checkWireBudget(payload, size), { ok: true });
    assert.deepEqual(checkWireBudget(payload, size - 1), { ok: false, code: 'over-budget' });
  });

  it('rejects a sync whose full payloads sum past 32 MiB', () => {
    const one = { n: 'x'.repeat(1024) };
    const count = Math.ceil((CLI_SYNC_MAX_BYTES + 1) / wireBytes(one));
    const over = checkSyncWireBudget(Array.from({ length: count }).fill(one));
    assert.deepEqual(over, { ok: false, code: 'over-budget' });
    assert.deepEqual(checkSyncWireBudget([one, one, one, one]), { ok: true });
  });
});

describe('agentRegisterSchema', () => {
  const uplink = {
    agentId: 'machine-1',
    hostname: 'devbox',
    version: '0.1.63',
    instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    liveIdes: ['cursor', 'codebuddy'],
    platform: 'darwin',
    contentSource: false,
  };

  it('accepts the current uplink payload without cliAcp', () => {
    assert.equal(agentRegisterSchema.safeParse(uplink).success, true);
    assert.equal(agentRegisterSchema.safeParse({
      agentId: 'machine-1',
      hostname: 'devbox',
      version: '0.1.63',
      owner: 'ardor',
    }).success, true);
    assert.equal(agentRegisterSchema.safeParse({
      agentId: 'machine-2',
      platform: 'linux',
      contentSource: true,
      liveIdes: [],
    }).success, true);
    assert.equal(agentRegisterSchema.safeParse({ platform: 'win32' }).success, true);
  });

  it('accepts an optional static cliAcp capability', () => {
    const parsed = agentRegisterSchema.safeParse({
      ...uplink,
      cliAcp: {
        protocolVersion: 1,
        platform: 'darwin',
        sources: [{ source: 'cursor-cli' }, { source: 'codebuddy-cli' }],
      },
    });
    assert.equal(parsed.success, true);
  });

  it('rejects unknown register fields and illegal cliAcp', () => {
    assert.equal(agentRegisterSchema.safeParse({ ...uplink, token: 'secret' }).success, false);
    assert.equal(agentRegisterSchema.safeParse({
      ...uplink,
      cliAcp: { protocolVersion: 1, platform: 'linux', sources: [] },
    }).success, false);
    assert.equal(agentRegisterSchema.safeParse({
      ...uplink,
      cliAcp: { protocolVersion: 2, platform: 'darwin', sources: [] },
    }).success, false);
    assert.equal(agentRegisterSchema.safeParse({
      ...uplink,
      cliAcp: { protocolVersion: 1, platform: 'darwin', sources: [{ source: 'cursor' }] },
    }).success, false);
    assert.equal(agentRegisterSchema.safeParse({
      ...uplink,
      cliAcp: { protocolVersion: 1, platform: 'darwin', sources: [{ source: 'cursor-cli', extra: true }] },
    }).success, false);
    assert.equal(agentRegisterSchema.safeParse({ ...uplink, liveIdes: ['cursor-cli'] }).success, false);
    assert.equal(agentRegisterSchema.safeParse({ ...uplink, platform: 'freebsd' }).success, false);
    assert.equal(agentRegisterSchema.safeParse({ ...uplink, contentSource: 'yes' }).success, false);
  });
});

describe('commandPayloadSchema', () => {
  it('keeps old IDE commands that omit target', () => {
    assert.equal(commandPayloadSchema.safeParse({}).success, false);
    assert.equal(commandPayloadSchema.safeParse({ commandId: 'c1', text: 'hi' }).success, true);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      text: 'hi',
      windowId: 'w1',
      tabTitle: 'Chat',
      selectorPath: 'div',
      composerId: 'comp',
      section: 'agents',
      ide: 'cursor',
    }).success, true);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      ide: 'codebuddy',
      approvalId: 'approval-0',
      selectorPath: 'button.primary',
      actionLabel: 'Accept',
    }).success, true);
  });

  it('accepts a cli target, source, and the two permission responses', () => {
    const target = { kind: 'cli', source: 'cursor-cli', sessionId: SESSION_A };
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      target,
      text: 'hello',
      clientMessageId: 'msg-1',
      source: 'codebuddy-cli',
    }).success, true);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      target,
      approvalId: approvalId(1),
      optionId: 'opt-1',
      response: { outcome: 'selected', optionId: 'opt-1' },
    }).success, true);
    const cancelled = commandPayloadSchema.safeParse({
      commandId: 'c1',
      target,
      approvalId: approvalId(1),
      response: { outcome: 'cancelled' },
    });
    assert.equal(cancelled.success, true);
  });

  it('accepts a cli_start body and still rejects unknown command fields', () => {
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      source: 'cursor-cli',
      cwd: '/tmp/lifeline',
      clientRequestId: 'req-1',
    }).success, true);
    assert.equal(commandPayloadSchema.safeParse({ commandId: 'c1', text: 'hi' }).success, true);
    // Absolute-path checks stay on assertCliStart; the shared schema only stores the string.
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      source: 'cursor-cli',
      cwd: 'relative/path',
    }).success, true);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      source: 'cursor-cli',
      cwd: '/tmp/lifeline',
      clientRequestId: 'req-1',
      unexpected: true,
    }).success, false);
  });

  it('rejects unknown command fields, bad sources, and a non-uuid cli approval id', () => {
    const target = { kind: 'cli', source: 'cursor-cli', sessionId: SESSION_A };
    assert.equal(commandPayloadSchema.safeParse({ commandId: 'c1', text: 'hi', unexpected: 1 }).success, false);
    assert.equal(commandPayloadSchema.safeParse({ commandId: 'c1', source: 'cursor' }).success, false);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      target: { kind: 'ide', source: 'cursor-cli', sessionId: SESSION_A },
    }).success, false);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      target: { kind: 'cli', source: 'cursor', sessionId: SESSION_A },
    }).success, false);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      target: { kind: 'cli', source: 'cursor-cli', sessionId: 'sess-1' },
    }).success, false);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      target,
      approvalId: 'approval-0',
      response: { outcome: 'cancelled' },
    }).success, false);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      response: { outcome: 'selected' },
    }).success, false);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      response: { outcome: 'cancelled', optionId: 'opt-1' },
    }).success, false);
    assert.equal(commandPayloadSchema.safeParse({
      commandId: 'c1',
      response: { outcome: 'rejected' },
    }).success, false);
  });

  it('does not put CLI command names on the 15 IDE command events', () => {
    assert.equal(COMMAND_EVENTS.length, 15);
    assert.equal(commandEventSchema.safeParse('command:send_message').success, true);
    assert.equal(commandEventSchema.safeParse('command:cli_start').success, false);
    assert.equal(commandEventSchema.safeParse('command:cli_permission_response').success, false);
  });
});

describe('server-injected agentId', () => {
  it('accepts optional agentId on snapshot, append, and full, and still rejects unknown fields', () => {
    assert.equal(cliSnapshotSchema.safeParse({ ...snapshot([]), agentId: 'machine-1' }).success, true);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([], { agentId: 'machine-1' })).success, true);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([], { agentId: 'machine-1' })).success, true);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([])).success, true);
    assert.equal(cliSnapshotSchema.safeParse({ ...snapshot([]), agentId: '' }).success, false);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([], { agentId: '' })).success, false);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([], { agentId: '' })).success, false);
    assert.equal(cliSnapshotSchema.safeParse({ ...snapshot([]), agentId: 'machine-1', extra: true }).success, false);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([], { agentId: 'machine-1', extra: true })).success, false);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([], { agentId: 'machine-1', extra: true })).success, false);
  });
});

describe('cli model catalog', () => {
  const catalog = {
    models: [
      { id: 'glm-5.2', label: 'GLM 5.2' },
      { id: 'kimi-k3', label: 'Kimi K3' },
    ],
    currentModelId: 'glm-5.2',
    thinking: {
      current: 'high',
      levels: [
        { value: 'enabled', label: 'On (default)' },
        { value: 'high', label: 'High' },
      ],
    },
  };

  it('accepts the session catalog on status and snapshot', () => {
    assert.equal(cliStatusSchema.safeParse({
      epoch: EPOCH,
      source: 'codebuddy-cli',
      sessionId: SESSION_A,
      status: 'idle',
      model: 'GLM 5.2',
      catalog,
      resumeCommand: 'cd \'/work\' && codebuddy --resume \'abc\' --model \'glm-5.2\'',
    }).success, true);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([
      snapshotSession({ model: 'GLM 5.2', catalog }),
    ])).success, true);
  });

  it('rejects an empty model list and an unknown catalog field', () => {
    assert.equal(cliStatusSchema.safeParse({
      epoch: EPOCH,
      source: 'cursor-cli',
      sessionId: SESSION_A,
      status: 'idle',
      catalog: { models: [] },
    }).success, false);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([
      snapshotSession({ catalog: { ...catalog, extra: true } }),
    ])).success, false);
  });
});

describe('cliSnapshotSchema', () => {
  it('accepts an empty inventory and more than four sessions', () => {
    assert.equal(cliSnapshotSchema.safeParse(snapshot([])).success, true);
    const sessions = Array.from({ length: 5 }, (_, i) => snapshotSession({
      sessionId: sessionId(i),
      seq: i,
    }));
    assert.equal(cliSnapshotSchema.safeParse(snapshot(sessions)).success, true);
  });

  it('rejects a bad seq and unknown fields', () => {
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({ seq: -1 })])).success, false);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({ seq: 1.5 })])).success, false);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({ seq: Number.NaN })])).success, false);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({ seq: Number.POSITIVE_INFINITY })])).success, false);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([
      snapshotSession({ seq: Number.MAX_SAFE_INTEGER }),
    ])).success, true);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([
      snapshotSession({ seq: Number.MAX_SAFE_INTEGER + 1 }),
    ])).success, false);
    assert.equal(cliSnapshotSchema.safeParse({ ...snapshot([]), extra: true }).success, false);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({ selectorPath: '#ok' })])).success, false);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({ sessionId: 'sess-1' })])).success, false);
    assert.equal(cliSnapshotSchema.safeParse({ ...snapshot([]), epoch: 'epoch-1' }).success, false);
  });

  it('caps options at 16 and approvals at 32, and keeps labels verbatim', () => {
    const longLabel = `允许\n${'文'.repeat(1500)}`;
    const options = Array.from({ length: CLI_APPROVAL_OPTION_LIMIT }, (_, i) => (
      option(i, i === 0 ? '' : i === 1 ? longLabel : 'Allow once')
    ));
    const parsed = cliSnapshotSchema.safeParse(snapshot([snapshotSession({
      approvals: [approval(options)],
    })]));
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.sessions[0]?.approvals[0]?.options[0]?.label, '');
      assert.equal(parsed.data.sessions[0]?.approvals[0]?.options[1]?.label, longLabel);
    }
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({
      approvals: [approval([...options, option(CLI_APPROVAL_OPTION_LIMIT)])],
    })])).success, false);

    const atCap = Array.from({ length: CLI_SNAPSHOT_APPROVAL_LIMIT }, (_, i) => approval([option()], i));
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({ approvals: atCap })])).success, true);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({
      approvals: [...atCap, approval([option()], CLI_SNAPSHOT_APPROVAL_LIMIT)],
    })])).success, false);
    assert.equal(cliSnapshotSchema.safeParse(snapshot([snapshotSession({
      approvals: [{ ...approval([option()]), approvalId: 'ap-1' }],
    })])).success, false);
  });

  it('rejects snapshot metadata over 256 KiB and accepts the exact boundary', () => {
    const emptyTitle = snapshot([snapshotSession({ title: '' })]);
    const room = CLI_SNAPSHOT_MAX_BYTES - wireBytes(emptyTitle);
    assert.ok(room > 0);
    const exact = snapshot([snapshotSession({ title: 'x'.repeat(room) })]);
    assert.equal(wireBytes(exact), CLI_SNAPSHOT_MAX_BYTES);
    assert.equal(cliSnapshotSchema.safeParse(exact).success, true);
    const over = snapshot([snapshotSession({ title: 'x'.repeat(room + 1) })]);
    assert.equal(cliSnapshotSchema.safeParse(over).success, false);
  });
});

describe('chatElementSchema', () => {
  const human = { type: 'human', id: 'h1', flatIndex: 0, text: 'hello', mentions: [] };
  const assistant = { type: 'assistant', id: 'a1', flatIndex: 1, text: 'hi', createdAt: 1_700_000_000 };
  const tool = {
    type: 'tool',
    id: 't1',
    flatIndex: 2,
    toolCallId: 'tc1',
    status: 'completed',
    action: 'read',
    details: 'file.ts',
  };
  const thought = { type: 'thought', id: 'th1', flatIndex: 3, duration: '2s' };
  const plan = {
    type: 'plan',
    id: 'p1',
    flatIndex: 4,
    label: 'Plan',
    title: 'Do the work',
    todosCompleted: 0,
    todosTotal: 1,
  };
  const todoList = {
    type: 'todo_list',
    id: 'td1',
    flatIndex: 5,
    title: 'Todos',
    todosCompleted: 0,
    todosTotal: 1,
    todos: [{ text: 'step', status: 'pending' }],
  };
  const notification = { type: 'notification', id: 'n1', flatIndex: 6, title: 'Finished', status: 'success' };
  const runCommand = {
    type: 'run_command',
    id: 'r1',
    flatIndex: 7,
    toolCallId: 'tc2',
    description: 'list',
    candidates: '',
    command: 'ls',
    actions: [{ label: 'Run', type: 'run', selectorPath: '#run' }],
  };
  const loading = { type: 'loading', id: 'l1', flatIndex: 8, text: 'Working' };

  it('accepts every chat element variant', () => {
    for (const element of [human, assistant, tool, thought, plan, todoList, notification, runCommand, loading])
      assert.equal(chatElementSchema.safeParse(element).success, true, element.type);
  });

  it('rejects a partial element, an unknown type, and an unknown field', () => {
    assert.equal(chatElementSchema.safeParse({ id: 'h1', type: 'human', flatIndex: 0 }).success, false);
    assert.equal(chatElementSchema.safeParse({ id: 't1', type: 'tool', flatIndex: 0 }).success, false);
    assert.equal(chatElementSchema.safeParse({ ...notification, title: undefined, status: undefined }).success, false);
    assert.equal(chatElementSchema.safeParse({ id: 'x', type: 'nope', flatIndex: 0 }).success, false);
    assert.equal(chatElementSchema.safeParse({ ...human, extra: true }).success, false);
    assert.equal(chatElementSchema.safeParse({ ...tool, status: 'ok' }).success, false);
    assert.equal(chatElementSchema.safeParse({ ...human, flatIndex: -1 }).success, false);
  });
});

describe('cliAppendSchema', () => {
  it('shallow-checks elements and preserves fields the deep schema would require', () => {
    const parsed = cliAppendSchema.safeParse(appendEnvelope([
      shallow({ text: 'keep me' }),
      { id: 't1', type: 'tool', flatIndex: 1 },
    ]));
    assert.equal(parsed.success, true);
    if (parsed.success) {
      const first = parsed.data.messages[0] as { text?: string };
      assert.equal(first?.text, 'keep me');
    }
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([])).success, true);
  });

  it('accepts trim markers and still rejects unknown fields', () => {
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([], {
      truncatedBefore: true,
      firstRetainedFlatIndex: 4,
    })).success, true);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([shallow()], {
      truncatedBefore: true,
    })).success, true);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([], {
      truncatedBefore: false,
    })).success, false);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([], {
      truncatedBefore: true,
      firstRetainedFlatIndex: 4,
      extra: true,
    })).success, false);
  });

  it('rejects a broken envelope, a 257th element, and an oversized payload', () => {
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([shallow()], { extra: true })).success, false);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([shallow({ id: '' })])).success, false);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([shallow({ flatIndex: 1.2 })])).success, false);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([shallow()], { seq: -1 })).success, false);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([shallow()], { source: 'cursor' })).success, false);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope(['nope'])).success, false);

    const atCap = Array.from({ length: CLI_APPEND_MAX_ELEMENTS }, (_, i) => shallow({ id: `m${i}`, flatIndex: i }));
    assert.equal(cliAppendSchema.safeParse(appendEnvelope(atCap)).success, true);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([
      ...atCap,
      shallow({ id: 'overflow', flatIndex: CLI_APPEND_MAX_ELEMENTS }),
    ])).success, false);

    const text = 'x'.repeat(600 * 1024);
    const wide = appendEnvelope([
      shallow({ id: 'a', text }),
      shallow({ id: 'b', type: 'assistant', flatIndex: 1, text }),
    ]);
    assert.equal(wireBytes(wide.messages[0]) <= CLI_ELEMENT_MAX_BYTES, true);
    assert.equal(wireBytes(wide) > CLI_APPEND_MAX_BYTES, true);
    assert.equal(cliAppendSchema.safeParse(wide).success, false);

    const huge = shallow({ text: 'y'.repeat(CLI_ELEMENT_MAX_BYTES) });
    assert.equal(wireBytes(huge) > CLI_ELEMENT_MAX_BYTES, true);
    assert.equal(cliAppendSchema.safeParse(appendEnvelope([huge])).success, false);
  });
});

describe('cliFullSchema', () => {
  const loadingAt = (i: number) => ({ type: 'loading' as const, id: `l${i}`, flatIndex: i });

  it('deep-parses an empty body and up to 2000 elements', () => {
    assert.equal(cliFullSchema.safeParse(fullEnvelope([])).success, true);
    const atCap = Array.from({ length: CLI_SESSION_BODY_MAX_ELEMENTS }, (_, i) => loadingAt(i));
    assert.equal(cliFullSchema.safeParse(fullEnvelope(atCap)).success, true);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([
      ...atCap,
      loadingAt(CLI_SESSION_BODY_MAX_ELEMENTS),
    ])).success, false);
  });

  it('rejects a shallow element that is not a complete chat element', () => {
    assert.equal(cliFullSchema.safeParse(fullEnvelope([
      { id: 'h1', type: 'human', flatIndex: 0 },
    ])).success, false);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([
      { id: 't1', type: 'tool', flatIndex: 0 },
    ])).success, false);
    assert.equal(chatElementSchema.safeParse({ id: 'h1', type: 'human', flatIndex: 0, text: 'hi', mentions: [] }).success, true);
  });

  it('accepts trim markers and still rejects unknown fields', () => {
    assert.equal(cliFullSchema.safeParse(fullEnvelope([], {
      truncatedBefore: true,
      firstRetainedFlatIndex: 2,
    })).success, true);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([], {
      truncatedBefore: true,
    })).success, true);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([], {
      firstRetainedFlatIndex: -1,
    })).success, false);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([], {
      truncatedBefore: true,
      firstRetainedFlatIndex: 2,
      extra: true,
    })).success, false);
  });

  it('rejects an element over 1 MiB and a body over 8 MiB', () => {
    const huge = {
      type: 'assistant' as const,
      id: 'a1',
      flatIndex: 0,
      text: 'z'.repeat(CLI_ELEMENT_MAX_BYTES),
    };
    assert.equal(wireBytes(huge) > CLI_ELEMENT_MAX_BYTES, true);
    assert.equal(wireBytes(fullEnvelope([huge])) <= CLI_FULL_MAX_BYTES, true);
    assert.equal(cliFullSchema.safeParse(fullEnvelope([huge])).success, false);

    const text = 'y'.repeat(900 * 1024);
    const assistantAt = (i: number) => ({ type: 'assistant' as const, id: `a${i}`, flatIndex: i, text });
    const under = Array.from({ length: 9 }, (_, i) => assistantAt(i));
    const over = [...under, assistantAt(9)];
    assert.equal(wireBytes(assistantAt(0)) <= CLI_ELEMENT_MAX_BYTES, true);
    assert.equal(wireBytes(fullEnvelope(under)) <= CLI_FULL_MAX_BYTES, true);
    assert.equal(cliFullSchema.safeParse(fullEnvelope(under)).success, true);
    assert.equal(wireBytes(fullEnvelope(over)) > CLI_FULL_MAX_BYTES, true);
    assert.equal(cliFullSchema.safeParse(fullEnvelope(over)).success, false);
  });
});

describe('validateInbound', () => {
  it('returns invalid-payload for an illegal browser command', () => {
    const result = validateInbound(commandPayloadSchema, { commandId: 'c1', nope: true }, 'invalid-payload');
    assert.deepEqual(result, { ok: false, code: 'invalid-payload' });
  });

  it('returns drop-and-log for an illegal agent cli event', () => {
    const result = validateInbound(cliAppendSchema, { epoch: EPOCH }, 'drop-and-log');
    assert.deepEqual(result, { ok: false, code: 'drop-and-log' });
  });

  it('returns reject-register for an illegal register', () => {
    const result = validateInbound(agentRegisterSchema, { agentId: 'machine-1', token: 'x' }, 'reject-register');
    assert.deepEqual(result, { ok: false, code: 'reject-register' });
  });

  it('returns fail-closed for an illegal server command', () => {
    const result = validateInbound(commandPayloadSchema, { commandId: 'c1', injected: true }, 'fail-closed');
    assert.deepEqual(result, { ok: false, code: 'fail-closed' });
  });

  it('returns the parsed payload without throwing', () => {
    assert.doesNotThrow(() => {
      validateInbound(commandPayloadSchema, null, 'fail-closed');
    });
    const result = validateInbound(commandPayloadSchema, { commandId: 'c1', text: 'hi' }, 'invalid-payload');
    assert.deepEqual(result, { ok: true, data: { commandId: 'c1', text: 'hi' } });
  });
});
