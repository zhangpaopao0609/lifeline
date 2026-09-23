import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import type { PendingSwitch } from '../packages/web/src/store/ui.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { viewedSessionIdOf } from '../packages/web/src/store/ides.ts';

/**
 * 2026-09-17 feedback: watching a questionnaire in session A, after clicking session B the old
 * questionnaire card still hangs above the composer until the server's next extract.
 *
 * Constraint: a questionnaire belongs to the session it was asked in — draw the card only while
 * viewing that session. "The session being viewed" prefers the optimistic switch target (real id),
 * else the server's active session; unknown identity (placeholder id / state not yet in) returns
 * an empty string and the caller does not decide (do not hide by mistake).
 */

function tab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    composerId: 'c1',
    title: '会话一',
    isActive: true,
    status: 'active',
    selectorPath: '',
    windowId: 'w1',
    ...overrides,
  };
}

function state(overrides: Partial<CursorState> = {}): CursorState {
  return {
    chatTabs: [tab()],
    activeWindowId: 'w1',
    activeComposerId: 'c1',
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    ...overrides,
  } as CursorState;
}

function pending(overrides: Partial<PendingSwitch> = {}): PendingSwitch {
  return {
    commandId: 'cmd-1',
    ide: 'cursor',
    composerId: 'c2',
    windowId: 'w1',
    title: '会话二',
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('viewedSessionIdOf', () => {
  it('没有切换时 = 服务端活跃会话', () => {
    assert.equal(viewedSessionIdOf(state()), 'c1');
  });

  it('乐观切换中 = 目标会话（旧会话的问卷卡据此刻即收）', () => {
    assert.equal(viewedSessionIdOf(state(), pending()), 'c2');
  });

  it('目标 id 是占位（tab-N）→ 退回活跃会话（身份不明就不判定）', () => {
    assert.equal(viewedSessionIdOf(state(), pending({ composerId: 'tab-3' })), 'c1');
  });

  it('活跃 id 是占位 / 状态没到 → 空串', () => {
    assert.equal(viewedSessionIdOf(state({ activeComposerId: 'tab-9' })), '');
    assert.equal(viewedSessionIdOf(undefined), '');
  });
});
