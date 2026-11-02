import type { CliApproval, CliModelCatalog, CliSnapshot, CliSnapshotSession } from '@lifeline/protocol';
import type { ActiveTarget, CliEffect, CliEvent } from '../packages/web/src/store/cli.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { messageText } from '../packages/web/src/components/CliTimeline.tsx';
import {
  applyCliEvent,
  canSendForTarget,
  CLI_ACTION_BAR_MAX_HEIGHT,
  CLI_FULL_TIMEOUT_MS,
  CLI_RESTART_NOTICE,
  cliApprovalCardOnClick,
  cliApprovalCardOnResult,
  cliApprovals,
  cliAwaitingFull,
  cliComposeBlock,
  cliDeadline,
  cliEpoch,
  cliInterfaceState,
  cliPermissionChoice,
  cliRailDot,
  cliSession,
  cliSessionKey,
  cliSyncStatus,
  composerDraftBucket,
  createCliState,
  isCliActionBarFolded,
  nextActiveTarget,
  paletteCliEntries,
  readComposerDraft,
  visibleCliApprovals,
  visibleCliSources,
  writeComposerDraft,
} from '../packages/web/src/store/cli.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

it('clears a recovered prompt error when a new CLI status arrives', () => {
  let state = createCliState();
  ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()]), 0)));
  ({ state } = applyCliEvent(state, { type: 'status', agentId: 'agent-a', status: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', status: 'idle', error: 'Request failed' } }));
  assert.equal(cliSession(state, 'agent-a', 'sess-1')?.error, 'Request failed');
  ({ state } = applyCliEvent(state, { type: 'status', agentId: 'agent-a', status: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', status: 'running' } }));
  assert.equal(cliSession(state, 'agent-a', 'sess-1')?.error, undefined);
});

function readSource(rel: string): string {
  try {
    return readFileSync(join(root, rel), 'utf8');
  }
  catch {
    return '';
  }
}

function syncCount(effects: CliEffect[]): number {
  return effects.filter(effect => effect.type === 'sync').length;
}

function noticeCount(effects: CliEffect[]): number {
  return effects.filter(effect => effect.type === 'restart-notice' && effect.text === CLI_RESTART_NOTICE).length;
}

function approval(overrides: Partial<CliApproval> = {}): CliApproval {
  return {
    approvalId: 'ap-1',
    sessionId: 'sess-1',
    title: '运行命令',
    state: 'pending',
    options: [{ optionId: 'allow', label: '允许', kind: 'allow_once' }],
    ...overrides,
  };
}

function snapSession(overrides: Partial<CliSnapshotSession> = {}): CliSnapshotSession {
  return {
    source: 'cursor-cli',
    sessionId: 'sess-1',
    cwd: '/tmp/work',
    status: 'idle',
    seq: 1,
    approvals: [],
    ...overrides,
  };
}

function snap(epoch: string, sessions: CliSnapshotSession[], snapshotId = 'snap-1'): CliSnapshot {
  return { epoch, snapshotId, sessions };
}

function human(text: string) {
  return { type: 'human' as const, id: `h-${text}`, flatIndex: 0, text, mentions: [] };
}

function snapshotEvent(agentId: string, snapshot: CliSnapshot, now: number): CliEvent {
  return { type: 'snapshot', agentId, snapshot, now };
}

describe('CLI session key', () => {
  it('两台机器的同一个 sessionId 不串正文', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()]), 0)));
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('from-a')],
      },
    }));
    ({ state } = applyCliEvent(state, snapshotEvent('agent-b', snap('epoch-b', [snapSession()]), 2)));
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-b',
      now: 3,
      full: {
        epoch: 'epoch-b',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('from-b')],
      },
    }));

    const a = cliSession(state, 'agent-a', 'sess-1');
    const b = cliSession(state, 'agent-b', 'sess-1');
    assert.ok(a && b);
    assert.equal(a.key, cliSessionKey('agent-a', 'epoch-a', 'cursor-cli', 'sess-1'));
    assert.notEqual(a.key, b.key);
    assert.equal(a.messages[0]?.type === 'human' ? a.messages[0].text : '', 'from-a');
    assert.equal(b.messages[0]?.type === 'human' ? b.messages[0].text : '', 'from-b');
  });
});

describe('cli:snapshot', () => {
  it('空数组清空该 agent 的会话、审批、awaitingFull 和计时器，另一台机器不动', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ approvals: [approval()] })]), 0)));
    ({ state } = applyCliEvent(state, snapshotEvent('agent-b', snap('epoch-b', [snapSession({ approvals: [approval({ approvalId: 'ap-b' })] })]), 0)));
    assert.equal(cliApprovals(state, 'agent-a').length, 1);
    assert.equal(cliAwaitingFull(state, 'agent-a').length, 1);
    assert.equal(cliDeadline(state, 'agent-a'), CLI_FULL_TIMEOUT_MS);

    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [], 'snap-empty'), 10)));
    assert.deepEqual(cliSession(state, 'agent-a', 'sess-1'), undefined);
    assert.deepEqual(cliApprovals(state, 'agent-a'), []);
    assert.deepEqual(cliAwaitingFull(state, 'agent-a'), []);
    assert.equal(cliDeadline(state, 'agent-a'), null);
    assert.equal(cliApprovals(state, 'agent-b').length, 1);
    assert.equal(cliEpoch(state, 'agent-b'), 'epoch-b');
  });
});

describe('awaitingFull', () => {
  it('只有 snapshotId 和 expectedSeq 都匹配的 full 才解除，空正文也算', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 2 })]), 0)));

    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 5,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-other',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 2,
        messages: [human('stale')],
      },
    }));
    assert.deepEqual(cliAwaitingFull(state, 'agent-a'), ['sess-1']);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 0);

    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 6,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 2,
        messages: [],
      },
    }));
    assert.deepEqual(cliAwaitingFull(state, 'agent-a'), []);
    assert.deepEqual(cliSession(state, 'agent-a', 'sess-1')?.messages, []);
    assert.equal(cliDeadline(state, 'agent-a'), null);
    assert.equal(syncCount(effects), 0);
  });

  it('一个合法 full 重置 120 秒窗口；缺 full 自动 sync 一次，再失败进入 sync-error', () => {
    assert.equal(CLI_FULL_TIMEOUT_MS, 120_000);
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [
      snapSession({ sessionId: 'sess-1', seq: 1 }),
      snapSession({ sessionId: 'sess-2', seq: 1 }),
    ]), 0)));
    assert.equal(cliSyncStatus(state, 'agent-a'), 'watching');
    assert.equal(cliDeadline(state, 'agent-a'), 120_000);

    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 100_000 }));
    assert.equal(syncCount(effects), 0);

    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 100_000,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('one')],
      },
    }));
    assert.equal(cliDeadline(state, 'agent-a'), 220_000);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'watching');
    assert.deepEqual(cliAwaitingFull(state, 'agent-a'), ['sess-2']);

    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 219_999 }));
    assert.equal(syncCount(effects), 0);
    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 220_000 }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'retrying');
    assert.equal(cliDeadline(state, 'agent-a'), 340_000);

    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 340_000 }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'sync-error');
    assert.equal(cliDeadline(state, 'agent-a'), null);

    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 999_000 }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'sync-error');

    ({ state, effects } = applyCliEvent(state, { type: 'manual-retry', now: 1_000_000 }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'retrying');
    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 1_120_000 }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'sync-error');
  });

  it('两次超时之间的 snapshot 不能把自动重试预算还回去', () => {
    let state = createCliState();
    let effects: CliEffect[] = [];
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 1 })]), 0)));
    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 120_000 }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'retrying');

    ({ state, effects } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 1 })], 'snap-2'), 180_000)));
    assert.equal(syncCount(effects), 0);
    assert.deepEqual(cliAwaitingFull(state, 'agent-a'), ['sess-1']);
    const secondDeadline = cliDeadline(state, 'agent-a');
    assert.ok(secondDeadline != null);
    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: secondDeadline }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'sync-error');

    ({ state, effects } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-b', [snapSession({ seq: 1 })], 'snap-b'), 400_000)));
    assert.equal(cliSyncStatus(state, 'agent-a'), 'watching');
    assert.equal(cliDeadline(state, 'agent-a'), 520_000);
    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 520_000 }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'retrying');

    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 520_001,
      full: {
        epoch: 'epoch-b',
        snapshotId: 'snap-b',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('done')],
      },
    }));
    assert.equal(cliSyncStatus(state, 'agent-a'), 'idle');
    assert.equal(cliDeadline(state, 'agent-a'), null);
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-b', [snapSession({ seq: 1 })], 'snap-b2'), 600_000)));
    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 720_000 }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'retrying');
  });
});

describe('seq', () => {
  it('小于 expected 丢弃，大于 expected 丢弃并请求 sync', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 2 })]), 0)));

    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('old')],
      },
    }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 0);
    assert.deepEqual(cliAwaitingFull(state, 'agent-a'), ['sess-1']);

    ({ state, effects } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 2,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 3,
        messages: [human('future')],
      },
    }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 0);
    assert.deepEqual(cliAwaitingFull(state, 'agent-a'), ['sess-1']);
  });

  it('full 之前的 append 标记 desync 且不缓存，重复 append 合并成一次 sync', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 2 })]), 0)));
    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 1,
      append: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', seq: 3, messages: [human('early')] },
    }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.desynced, true);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 0);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.awaitingFull, true);

    ({ state, effects } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 2,
      append: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', seq: 4, messages: [human('again')] },
    }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 0);
  });

  it('未知会话的 full 丢弃并 sync，不能借此创建会话', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()]), 0)));
    const effects = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-unknown',
        seq: 0,
        messages: [human('nope')],
      },
    });
    assert.equal(cliSession(effects.state, 'agent-a', 'sess-unknown'), undefined);
    assert.equal(syncCount(effects.effects), 1);
    assert.equal(cliSession(effects.state, 'agent-a', 'sess-1')?.awaitingFull, true);
    const again = applyCliEvent(effects.state, {
      type: 'full',
      agentId: 'agent-a',
      now: 2,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-unknown',
        seq: 0,
        messages: [human('still-nope')],
      },
    });
    assert.equal(cliSession(again.state, 'agent-a', 'sess-unknown'), undefined);
    assert.equal(syncCount(again.effects), 0);
  });

  it('解除 awaitingFull 之后，旧 checkpoint 的 full 不倒回正文和 seq', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 1 })]), 0)));
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('base')],
      },
    }));
    ({ state } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 2,
      append: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', seq: 2, messages: [human('next')] },
    }));
    const effects = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 3,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('rewind')],
      },
    });
    const session = cliSession(effects.state, 'agent-a', 'sess-1');
    assert.equal(session?.seq, 2);
    assert.equal(session?.awaitingFull, false);
    assert.deepEqual(session?.messages.map(message => message.type === 'human' ? message.text : ''), ['base', 'next']);
    assert.equal(syncCount(effects.effects), 0);
  });

  it('有 baseline 之后 append 严格按 last+1，缺口进入 desync', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 1 })]), 0)));
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('base')],
      },
    }));

    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 2,
      append: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', seq: 1, messages: [human('dup')] },
    }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 1);

    ({ state, effects } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 3,
      append: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', seq: 2, messages: [human('next')] },
    }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 2);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.seq, 2);

    ({ state, effects } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 4,
      append: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', seq: 4, messages: [human('gap')] },
    }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.desynced, true);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 2);
  });

  it('两次 append 同一 id 时替换成更长正文，不另起一行', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 1 })]), 0)));
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [
          { type: 'human', id: 'h1', flatIndex: 0, text: '问', mentions: [] },
          { type: 'assistant', id: 'a1', flatIndex: 1, text: '短' },
        ],
      },
    }));
    ({ state } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 2,
      append: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 2,
        messages: [{ type: 'assistant', id: 'a1', flatIndex: 1, text: '短更长' }],
      },
    }));
    ({ state } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 3,
      append: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 4,
        messages: [{ type: 'assistant', id: 'a1', flatIndex: 1, text: '短更长的正文' }],
      },
    }));
    const gapped = cliSession(state, 'agent-a', 'sess-1');
    assert.equal(gapped?.seq, 2);
    assert.equal(gapped?.messages.length, 2);
    assert.equal(gapped?.messages[1]?.type === 'assistant' ? gapped.messages[1].text : '', '短更长');

    ({ state } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 4,
      append: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 3,
        messages: [
          { type: 'assistant', id: 'a1', flatIndex: 1, text: '短更长的正文' },
          { type: 'assistant', id: 'a2', flatIndex: 2, text: '下一条' },
        ],
      },
    }));
    const session = cliSession(state, 'agent-a', 'sess-1');
    assert.equal(session?.seq, 3);
    assert.equal(session?.desynced, false);
    assert.deepEqual(session?.messages.map(message => message.id), ['h1', 'a1', 'a2']);
    assert.equal(session?.messages[1]?.type === 'assistant' ? session.messages[1].text : '', '短更长的正文');
  });
});

describe('CLI thought text', () => {
  it('action 为空时显示 detail，有 action 时仍显示 action', () => {
    const base = { type: 'thought' as const, id: 't1', flatIndex: 0, duration: '' };
    assert.equal(messageText({ ...base, detail: '考虑一下' }), '考虑一下');
    assert.equal(messageText({ ...base, action: '', detail: '考虑一下' }), '考虑一下');
    assert.equal(messageText({ ...base, action: 'Thought', detail: '正文' }), 'Thought');
  });
});

describe('epoch', () => {
  it('只有 snapshot 能切换 epoch；新 epoch 原子清场并提示一次，首次加载不提示', () => {
    let state = createCliState();
    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()]), 0)));
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('kept')],
      },
    }));
    assert.equal(noticeCount(effects), 0);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-a');

    ({ state, effects } = applyCliEvent(state, {
      type: 'session-created',
      agentId: 'agent-a',
      created: {
        epoch: 'epoch-b',
        source: 'cursor-cli',
        sessionId: 'sess-new',
        cwd: '/tmp/new',
        status: 'starting',
        seq: 0,
      },
    }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-a');
    assert.equal(cliSession(state, 'agent-a', 'sess-new'), undefined);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 1);

    ({ state, effects } = applyCliEvent(state, {
      type: 'session-created',
      agentId: 'agent-a',
      created: {
        epoch: 'epoch-b',
        source: 'cursor-cli',
        sessionId: 'sess-new',
        cwd: '/tmp/new',
        status: 'starting',
        seq: 0,
      },
    }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-a');

    ({ state, effects } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-b', [], 'snap-b'), 20)));
    assert.equal(noticeCount(effects), 1);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-b');
    assert.equal(cliSession(state, 'agent-a', 'sess-1'), undefined);
    assert.deepEqual(cliApprovals(state, 'agent-a'), []);
    assert.equal(cliDeadline(state, 'agent-a'), null);
    assert.equal(cliSyncStatus(state, 'agent-a'), 'idle');

    ({ state, effects } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-b', [], 'snap-b2'), 30)));
    assert.equal(noticeCount(effects), 0);

    const target = nextActiveTarget(
      { kind: 'cli', agentId: 'agent-a', epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1' },
      'agent-a',
      'epoch-b',
      'codebuddy',
    );
    assert.deepEqual(target, { kind: 'ide', ide: 'codebuddy' });
  });

  it('新 epoch 快照丢掉待审批，不把旧卡带进新 epoch', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [
      snapSession({ approvals: [approval()] }),
    ]), 0)));
    assert.deepEqual(cliApprovals(state, 'agent-a').map(item => item.approvalId), ['ap-1']);
    assert.equal(cliApprovals(state, 'agent-a')[0]?.state, 'pending');

    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-b', [
      snapSession({ approvals: [approval({ approvalId: 'ap-new', title: '新一轮' })] }),
    ], 'snap-b'), 20)));
    assert.equal(noticeCount(effects), 1);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-b');
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.epoch, 'epoch-b');
    assert.deepEqual(cliApprovals(state, 'agent-a').map(item => item.approvalId), ['ap-new']);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.approvals.some(item => item.approvalId === 'ap-1'), false);

    ({ state } = applyCliEvent(state, {
      type: 'approval',
      agentId: 'agent-a',
      approval: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        approval: approval(),
      },
    }));
    assert.deepEqual(cliApprovals(state, 'agent-a').map(item => item.approvalId), ['ap-new']);
  });

  it('starting 的 session-created 立刻入列并要求打开这一行', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', []), 0)));
    const applied = applyCliEvent(state, {
      type: 'session-created',
      agentId: 'agent-a',
      created: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-new',
        cwd: '/tmp/proj',
        status: 'starting',
        seq: 0,
      },
    });
    assert.equal(cliSession(applied.state, 'agent-a', 'sess-new')?.status, 'starting');
    assert.deepEqual(applied.effects.filter(effect => effect.type === 'open-session'), [{
      type: 'open-session',
      agentId: 'agent-a',
      epoch: 'epoch-a',
      source: 'cursor-cli',
      sessionId: 'sess-new',
    }]);
  });

  it('同 epoch 的 session-created 让会话可被空 full 解除；旧 epoch 的 append 丢弃', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', []), 0)));
    ({ state } = applyCliEvent(state, {
      type: 'session-created',
      agentId: 'agent-a',
      created: {
        epoch: 'epoch-a',
        source: 'codebuddy-cli',
        sessionId: 'sess-2',
        cwd: '/tmp/cb',
        status: 'idle',
        seq: 0,
      },
    }));
    assert.equal(cliSession(state, 'agent-a', 'sess-2')?.awaitingFull, true);
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 2,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'not-the-inventory',
        source: 'codebuddy-cli',
        sessionId: 'sess-2',
        seq: 0,
        messages: [],
      },
    }));
    assert.equal(cliSession(state, 'agent-a', 'sess-2')?.awaitingFull, false);

    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-b', [snapSession({ seq: 1 })]), 3)));
    ({ state, effects } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 4,
      append: { epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1', seq: 2, messages: [human('ghost')] },
    }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-b');
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 0);
  });

  it('旧 epoch 的 session-created 丢弃，更新的 epoch 只 sync 不装进旧 epoch', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-z', [snapSession()]), 0)));
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()], 'snap-a'), 1)));
    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, {
      type: 'session-created',
      agentId: 'agent-a',
      created: {
        epoch: 'epoch-z',
        source: 'cursor-cli',
        sessionId: 'sess-old',
        cwd: '/tmp/old',
        status: 'starting',
        seq: 0,
      },
    }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-a');
    assert.equal(cliSession(state, 'agent-a', 'sess-old'), undefined);
    ({ state, effects } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()], 'snap-a2'), 2)));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSession(state, 'agent-a', 'sess-old'), undefined);

    ({ state, effects } = applyCliEvent(state, {
      type: 'session-created',
      agentId: 'agent-a',
      created: {
        epoch: 'epoch-m',
        source: 'cursor-cli',
        sessionId: 'sess-new',
        cwd: '/tmp/new',
        status: 'starting',
        seq: 0,
      },
    }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-a');
    assert.equal(cliSession(state, 'agent-a', 'sess-new'), undefined);
    ({ state, effects } = applyCliEvent(state, {
      type: 'session-created',
      agentId: 'agent-a',
      created: {
        epoch: 'epoch-m',
        source: 'cursor-cli',
        sessionId: 'sess-new',
        cwd: '/tmp/new',
        status: 'starting',
        seq: 0,
      },
    }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliSession(state, 'agent-a', 'sess-new'), undefined);
  });

  it('断线停表且不清理，重连后重新 sync', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()]), 0)));
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [human('stay')],
      },
    }));
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession(), snapSession({ sessionId: 'sess-2' })], 'snap-2'), 2)));

    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, { type: 'disconnect' }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliDeadline(state, 'agent-a'), null);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-a');
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages[0]?.type === 'human'
      ? cliSession(state, 'agent-a', 'sess-1')?.messages[0].text
      : '', 'stay');

    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: 500_000 }));
    assert.equal(syncCount(effects), 0);
    assert.notEqual(cliSyncStatus(state, 'agent-a'), 'sync-error');

    ({ state, effects } = applyCliEvent(state, { type: 'reconnect', now: 500_000 }));
    assert.equal(syncCount(effects), 1);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.messages.length, 1);
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-a');
  });

  it('切到另一台机器停表，但不丢掉原来的会话', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()]), 0)));
    let effects: CliEffect[] = [];
    ({ state, effects } = applyCliEvent(state, { type: 'select-agent', agentId: 'agent-b' }));
    ({ state, effects } = applyCliEvent(state, { type: 'tick', now: CLI_FULL_TIMEOUT_MS }));
    assert.equal(syncCount(effects), 0);
    assert.equal(cliDeadline(state, 'agent-a'), null);
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.awaitingFull, true);
  });
});

describe('CliApprovalCard state', () => {
  it('点击后整卡禁用；already-resolved 提示；失败且快照仍 pending 时恢复', () => {
    const pending = { disabled: false, phase: 'pending' as const, notice: null };
    const clicked = cliApprovalCardOnClick(pending);
    assert.equal(clicked.disabled, true);
    assert.equal(clicked.phase, 'resolving');

    const hinted = cliApprovalCardOnResult(clicked, { ok: false, ui: 'already-resolved' }, true);
    assert.equal(hinted.notice, 'already-resolved');
    assert.equal(hinted.disabled, true);

    const restored = cliApprovalCardOnResult(clicked, { ok: false, ui: 'failed' }, true);
    assert.equal(restored.disabled, false);
    assert.equal(restored.phase, 'pending');
    assert.equal(restored.notice, null);

    const gone = cliApprovalCardOnResult(clicked, { ok: false, ui: 'failed' }, false);
    assert.equal(gone.disabled, true);
  });

  it('未知选项是界面状态，不是 reject，也不读 wire errorCode', () => {
    const choice = cliPermissionChoice({ optionId: 'odd', label: '奇怪', kind: 'unknown' });
    assert.equal(choice.kind, 'unsupported-permission-option');
    assert.equal(cliPermissionChoice({ optionId: 'allow', label: '允许', kind: 'allow_once' }).kind, 'selected');

    assert.deepEqual(cliInterfaceState({ ok: false, errorCode: 'provider-error', error: 'boom' }), { ok: false, ui: 'failed' });
    assert.deepEqual(cliInterfaceState({ ok: false, data: { state: 'already-resolved' } }), { ok: false, ui: 'already-resolved' });
    assert.deepEqual(cliInterfaceState({ ok: false, error: 'busy' }), { ok: false, ui: 'busy' });
    assert.equal(cliComposeBlock('running'), 'busy');
    assert.equal(cliComposeBlock('idle'), null);
  });
});

describe('ActiveTarget', () => {
  it('CLI 不要求 IDE connected 或 contentOnly，切回 IDE 仍按原规则拦截', () => {
    const shared = {
      draft: 'hello',
      ideConnected: false,
      contentOnly: true,
      machineOffline: false,
      uplinkConnected: true,
      machineConnected: true,
      pendingSwitch: false,
      working: false,
      hasIdeTarget: true,
      cliStatus: 'idle' as const,
    };
    assert.equal(canSendForTarget(
      { kind: 'cli', agentId: 'agent-a', epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1' },
      shared,
    ), true);
    assert.equal(canSendForTarget({ kind: 'ide', ide: 'cursor' }, shared), false);
    assert.equal(canSendForTarget({ kind: 'ide', ide: 'cursor' }, {
      ...shared,
      ideConnected: true,
      contentOnly: false,
    }), true);
    assert.equal(canSendForTarget({ kind: 'ide', ide: 'codebuddy' }, {
      ...shared,
      ideConnected: true,
      contentOnly: true,
    }), false);

    const ide: ActiveTarget = { kind: 'ide', ide: 'cursor' };
    assert.equal(nextActiveTarget(ide, 'agent-a', 'epoch-b', 'codebuddy'), ide);
    const cli: ActiveTarget = { kind: 'cli', agentId: 'agent-a', epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1' };
    assert.equal(nextActiveTarget(cli, 'agent-b', 'epoch-z', 'cursor'), cli);
    assert.equal(nextActiveTarget(cli, 'agent-a', 'epoch-a', 'cursor'), cli);
  });

  it('draft 按 CLI target 隔离，IDE 仍共用一格', () => {
    const ideA: ActiveTarget = { kind: 'ide', ide: 'cursor' };
    const ideB: ActiveTarget = { kind: 'ide', ide: 'codebuddy' };
    const cliA: ActiveTarget = { kind: 'cli', agentId: 'agent-a', epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-1' };
    const cliB: ActiveTarget = { kind: 'cli', agentId: 'agent-a', epoch: 'epoch-a', source: 'cursor-cli', sessionId: 'sess-2' };
    assert.equal(composerDraftBucket(ideA), composerDraftBucket(ideB));
    assert.notEqual(composerDraftBucket(cliA), composerDraftBucket(cliB));
    let drafts: Record<string, string> = {};
    drafts = writeComposerDraft(drafts, cliA, 'aaa');
    drafts = writeComposerDraft(drafts, cliB, 'bbb');
    drafts = writeComposerDraft(drafts, ideA, 'ide');
    assert.equal(readComposerDraft(drafts, cliA), 'aaa');
    assert.equal(readComposerDraft(drafts, cliB), 'bbb');
    assert.equal(readComposerDraft(drafts, ideB), 'ide');
  });
});

describe('Agent CLI rail dot', () => {
  it('lights only when a reported CLI is ready and the machine is online', () => {
    const ready = [{ availability: 'ready' }];
    const unknown = [{ availability: 'unknown' }, { availability: 'unknown' }];
    const failed = [{ availability: 'binary-missing' }, { availability: 'error' }];
    assert.equal(cliRailDot(true, ready), 'on');
    assert.equal(cliRailDot(true, [{ availability: 'ready' }, { availability: 'binary-missing' }]), 'on');
    assert.equal(cliRailDot(false, ready), 'off');
    assert.equal(cliRailDot(true, failed), 'off');
    assert.equal(cliRailDot(true, unknown), 'hidden');
    assert.equal(cliRailDot(true, []), 'hidden');
    assert.equal(cliRailDot(true, ready, 1), 'on');
    assert.equal(cliRailDot(true, ready, 0), 'hidden');
    assert.equal(cliRailDot(true, failed, 1), 'on');
    assert.equal(cliRailDot(true, failed, 0), 'off');
    assert.equal(cliRailDot(false, ready, 2), 'off');
  });
});

describe('CLI 入口', () => {
  it('只列出 darwin 上机器列表投影出来的 source', () => {
    assert.deepEqual(visibleCliSources({ platform: 'linux', cliSources: [{ source: 'cursor-cli', availability: 'ready' }] }), []);
    assert.deepEqual(visibleCliSources({ platform: 'darwin' }), []);
    assert.deepEqual(visibleCliSources(undefined), []);
    const only = visibleCliSources({
      platform: 'darwin',
      cliSources: [{ source: 'codebuddy-cli', availability: 'unknown' }],
    });
    assert.deepEqual(only.map(row => row.source), ['codebuddy-cli']);
    assert.deepEqual(
      paletteCliEntries({
        platform: 'darwin',
        cliSources: [
          { source: 'cursor-cli', availability: 'ready' },
          { source: 'not-a-cli', availability: 'ready' },
        ],
      }).map(row => row.source),
      ['cursor-cli'],
    );
    assert.equal(paletteCliEntries({ platform: 'win32', cliSources: [{ source: 'cursor-cli', availability: 'ready' }] }).length, 0);
  });

  it('同时只展开一张卡；低高度或软键盘折叠成一行计数', () => {
    const pending = [approval(), approval({ approvalId: 'ap-2' })];
    const folded = visibleCliApprovals(pending, true);
    assert.equal(folded.expanded, null);
    assert.equal(folded.foldedLine, '有 2 个待审批');
    const open = visibleCliApprovals(pending, false);
    assert.equal(open.expanded?.approvalId, 'ap-1');
    assert.equal(open.extraCount, 1);
    assert.equal(visibleCliApprovals([approval({ state: 'resolved' })], false).expanded, null);

    assert.equal(isCliActionBarFolded(481, 0), false);
    assert.equal(isCliActionBarFolded(480, 0), true);
    assert.equal(isCliActionBarFolded(800, 99), false);
    assert.equal(isCliActionBarFolded(800, 100), true);
    assert.equal(CLI_ACTION_BAR_MAX_HEIGHT, 'min(32dvh, 220px)');
  });
});

describe('CLI 布局与 IDE 分界', () => {
  it('Composer 不收缩，审批条有上限，时间线保持 flex', () => {
    const css = readSource('packages/web/src/styles/tokens.css');
    const at = css.indexOf('.composer-dock {');
    const block = at >= 0 ? css.slice(at, at + 280) : '';
    assert.match(block, /flex-shrink:\s*0/);

    const bar = readSource('packages/web/src/components/CliActionBar.tsx');
    assert.match(bar, /CLI_ACTION_BAR_MAX_HEIGHT/);
    assert.match(bar, /overflowY:\s*'auto'/);
    assert.match(bar, /visibleCliApprovals/);
    assert.match(bar, /isCliActionBarFolded/);
    assert.doesNotMatch(bar, /approvals\.map/);

    const timeline = readSource('packages/web/src/components/CliTimeline.tsx');
    assert.match(timeline, /function CliTimeline/);
    assert.match(timeline, /flex:\s*1/);
    assert.match(timeline, /minHeight:\s*0/);
    assert.doesNotMatch(timeline, /parseIde/);
    assert.doesNotMatch(timeline, /TimelineVirtuoso/);
    assert.doesNotMatch(timeline, /useSessionsStore/);

    const card = readSource('packages/web/src/components/CliApprovalCard.tsx');
    assert.match(card, /function CliApprovalCard/);
    assert.match(card, /该审批已处理/);
    assert.match(card, /取消请求/);
    assert.doesNotMatch(card, /selectorPath/);
    assert.doesNotMatch(card, /from '\.\/ApprovalCard'/);
  });

  it('TargetActionArea 按完整 target key 挂上 CLI 条，IDE ActionCenter 仍在', () => {
    const shell = readSource('packages/web/src/components/AppShell.tsx');
    assert.match(shell, /function TargetActionArea/);
    assert.match(shell, /ActionCenter/);
    assert.match(shell, /CliActionBar/);
    assert.match(shell, /cliTargetKey/);
    assert.match(shell, /CliTimeline/);
  });

  it('IDE Composer 保留 mode 和 queue，CLI 只展示会话自己的模型目录', () => {
    const composer = readSource('packages/web/src/components/Composer.tsx');
    const ideAt = composer.indexOf('function IdeComposer');
    const cliAt = composer.indexOf('function CliComposer');
    assert.ok(ideAt >= 0 && cliAt > ideAt);
    const ide = composer.slice(ideAt, cliAt);
    const cli = composer.slice(cliAt);
    assert.match(ide, /machineContentOnly/);
    assert.match(ide, /ModeModelPicker/);
    assert.match(ide, /QueuePopover/);
    assert.doesNotMatch(ide, /composerDraftBucket/);
    assert.match(cli, /canSendForTarget/);
    assert.match(cli, /composerDraftBucket/);
    assert.match(cli, /CliModelBar/);
    assert.match(cli, /target\.source === 'cursor-cli' \? undefined : session\?\.resumeCommand/);
    assert.doesNotMatch(cli, /ModeModelPicker/);
    assert.doesNotMatch(cli, /QueuePopover/);
    assert.doesNotMatch(cli, /command:set_model/);
    assert.doesNotMatch(readSource('packages/web/src/components/CliModelBar.tsx'), /command:set_model/);
    assert.doesNotMatch(readSource('packages/web/src/components/CliModelBar.tsx'), /set_config_option/);
  });

  it('入口不调用 canControlIde，CommandPalette 只走投影', () => {
    const files = [
      'packages/web/src/store/cli.ts',
      'packages/web/src/components/SessionList.tsx',
      'packages/web/src/components/CommandPalette.tsx',
      'packages/web/src/components/AppShell.tsx',
      'packages/web/src/net/bind.ts',
      'packages/web/src/net/send.ts',
    ];
    for (const rel of files) {
      const text = readSource(rel);
      assert.ok(text.length > 0, rel);
      assert.doesNotMatch(text, /canControlIde/);
      assert.doesNotMatch(text, /packages\/agent/);
    }
    const store = readSource('packages/web/src/store/cli.ts');
    assert.doesNotMatch(store, /useSessionsStore/);
    assert.doesNotMatch(store, /parseIde/);
    const palette = readSource('packages/web/src/components/CommandPalette.tsx');
    assert.match(palette, /paletteCliEntries/);
    const bind = readSource('packages/web/src/net/bind.ts');
    assert.match(bind, /cli:snapshot/);
    assert.match(bind, /cli:sync-request/);
    assert.match(bind, /cli:full/);
    assert.match(bind, /cli:append/);
  });
});

describe('cli model catalog', () => {
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

  it('keeps the catalog from status and from a later snapshot', () => {
    let state = createCliState();
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession()]), 0)));
    ({ state } = applyCliEvent(state, {
      type: 'status',
      agentId: 'agent-a',
      status: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        status: 'idle',
        model: 'GLM 5.2',
        catalog,
      },
    }));
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.model, 'GLM 5.2');
    assert.deepEqual(cliSession(state, 'agent-a', 'sess-1')?.catalog, catalog);

    ({ state } = applyCliEvent(state, {
      type: 'status',
      agentId: 'agent-a',
      status: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        status: 'running',
      },
    }));
    assert.deepEqual(cliSession(state, 'agent-a', 'sess-1')?.catalog, catalog);

    const next = structuredClone(catalog);
    next.currentModelId = 'kimi-k3';
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [
      snapSession({ model: 'Kimi K3', catalog: next }),
    ], 'snap-2'), 2)));
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.model, 'Kimi K3');
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.catalog?.currentModelId, 'kimi-k3');
  });
});

describe('store entry validation', () => {
  it('ignores a non-string snapshot epoch and a non-integer append seq', () => {
    let state = createCliState();
    const fresh = state;
    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', {
      ...snap('epoch-a', [snapSession()]),
      epoch: 1 as unknown as string,
    }, 0)));
    assert.deepEqual(state, fresh);

    ({ state } = applyCliEvent(state, snapshotEvent('agent-a', snap('epoch-a', [snapSession({ seq: 1 })]), 0)));
    assert.equal(cliEpoch(state, 'agent-a'), 'epoch-a');
    ({ state } = applyCliEvent(state, {
      type: 'full',
      agentId: 'agent-a',
      now: 1,
      full: {
        epoch: 'epoch-a',
        snapshotId: 'snap-1',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1,
        messages: [],
      },
    }));
    const applied = state;
    assert.equal(cliSession(state, 'agent-a', 'sess-1')?.seq, 1);

    ({ state } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 2,
      append: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 1.5,
        messages: [human('bad')],
      },
    }));
    assert.deepEqual(state, applied);

    ({ state } = applyCliEvent(state, {
      type: 'append',
      agentId: 'agent-a',
      now: 3,
      append: {
        epoch: 'epoch-a',
        source: 'cursor-cli',
        sessionId: 'sess-1',
        seq: 2,
        messages: [human('ok')],
      },
    }));
    const session = cliSession(state, 'agent-a', 'sess-1');
    assert.equal(session?.seq, 2);
    assert.equal(session?.messages.length, 1);
    assert.equal(messageText(session!.messages[0]!), 'ok');
  });
});
