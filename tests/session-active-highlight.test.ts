import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import type { PendingSwitch } from '../packages/web/src/store/ui.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isViewingTab, pendingMatchesTab } from '../packages/web/src/store/ides.ts';

/**
 * 2026-09-15 feedback: after clicking a session the list can be captured with two active states at once.
 *
 * Root cause: highlight = "this window's active row" ∪ "optimistic switch target", and the server
 * only moves isActive to the target on the next extract — in that gap both rows qualify. Constraint:
 * at most one row is "the current session" at a time; whoever was clicked owns it immediately, and
 * the old row drops to secondary styling at once.
 */

function tab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    composerId: 'c1',
    title: '会话一',
    isActive: false,
    status: 'idle',
    selectorPath: '',
    windowId: 'w1',
    ...overrides,
  };
}

function stateWith(tabs: ChatTab[], overrides: Partial<CursorState> = {}): CursorState {
  return {
    chatTabs: tabs,
    activeWindowId: 'w1',
    activeComposerId: tabs.find(t => t.isActive)?.composerId ?? '',
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
    startedAt: 0,
    ...overrides,
  };
}

/** After the user clicked B, before the server confirms: A is still isActive, B is not yet */
function midSwitchState(): CursorState {
  return stateWith([
    tab({ composerId: 'c1', title: '空闲会话 A', isActive: true }),
    tab({ composerId: 'c2', title: '会话 B' }),
  ]);
}

describe('isViewingTab', () => {
  it('同一窗口内切换中只亮目标行，旧活跃行立刻降级（双激活态回归）', () => {
    const state = midSwitchState();
    const a = state.chatTabs![0];
    const b = state.chatTabs![1];
    const p = pending({ composerId: 'c2', windowId: 'w1' });

    assert.equal(isViewingTab(b, 'w1', 'cursor', state, p), true);
    assert.equal(isViewingTab(a, 'w1', 'cursor', state, p), false);
  });

  it('切换中跨窗口也只亮目标行，原窗口的活跃行不让位', () => {
    const state = stateWith([
      tab({ composerId: 'c1', title: '本地会话', isActive: true, windowId: 'w1' }),
      tab({ composerId: 'c2', title: '远程会话', windowId: 'w2' }),
    ]);
    const p = pending({ composerId: 'c2', windowId: 'w2' });

    assert.equal(isViewingTab(state.chatTabs![1], 'w2', 'cursor', state, p), true);
    assert.equal(isViewingTab(state.chatTabs![0], 'w1', 'cursor', state, p), false);
  });

  it('没有切换中时，本窗口活跃行是当前会话，别的窗口的活跃行不是', () => {
    const state = stateWith([
      tab({ composerId: 'c1', isActive: true, windowId: 'w1' }),
      tab({ composerId: 'c2', isActive: true, windowId: 'w2' }),
    ]);

    assert.equal(isViewingTab(state.chatTabs![0], 'w1', 'cursor', state, null), true);
    assert.equal(isViewingTab(state.chatTabs![1], 'w2', 'cursor', state, null), false);
  });

  it('别的 IDE 的切换中不影响本 IDE（高亮照旧按 isActive）', () => {
    const state = midSwitchState();
    const p = pending({ ide: 'codebuddy', composerId: 'c2' });

    assert.equal(isViewingTab(state.chatTabs![0], 'w1', 'cursor', state, p), true);
    assert.equal(isViewingTab(state.chatTabs![1], 'w1', 'cursor', state, p), false);
  });

  it('synthetic 目标（tab-N）按窗口内 id 认，不跨窗口误亮', () => {
    const state = stateWith([
      tab({ composerId: 'tab-1', windowId: 'w1' }),
      tab({ composerId: 'tab-1', windowId: 'w2' }),
    ]);
    const p = pending({ composerId: 'tab-1', windowId: 'w2' });

    assert.equal(isViewingTab(state.chatTabs![1], 'w2', 'cursor', state, p), true);
    assert.equal(isViewingTab(state.chatTabs![0], 'w1', 'cursor', state, p), false);
  });

  it('目标行的 windowId 缺失时用分组 id 兜底匹配', () => {
    const state = stateWith([tab({ composerId: 'c2', windowId: undefined })]);
    const p = pending({ composerId: 'c2', windowId: 'w1' });

    assert.equal(isViewingTab(state.chatTabs![0], 'w1', 'cursor', state, p), true);
  });

  it('已确认（confirmed）的切换里高亮不乱：等状态追上期间只亮目标行', () => {
    const state = midSwitchState();
    const a = state.chatTabs![0];
    const b = state.chatTabs![1];
    const p = pending({ composerId: 'c2', windowId: 'w1', confirmed: true });

    assert.equal(isViewingTab(b, 'w1', 'cursor', state, p), true);
    assert.equal(isViewingTab(a, 'w1', 'cursor', state, p), false);
  });
});

/**
 * At settle time the row id swaps from a placeholder (tab-N) to the real id; the position key
 * (window + same-name index + title) is stable across that instant — without it, highlight drops
 * then comes back when the switch completes (a flash).
 */
describe('pendingMatchesTab', () => {
  it('行 id 换成真 id 后，靠位置键仍认得出同一行', () => {
    const r = tab({ composerId: 'real-id', windowId: 'w1', title: '同名会话', sameTitleIndex: 2 });
    const p = pending({ composerId: 'tab-2', windowId: 'w1', title: '同名会话', sameTitleIndex: 2, confirmed: true });

    assert.equal(pendingMatchesTab(p, r, 'w1'), true);
  });

  it('同名同序号但换了窗口不算同一行（位置键只在窗口内成立）', () => {
    const r = tab({ composerId: 'x', windowId: 'w2', title: '同名会话', sameTitleIndex: 2 });
    const p = pending({ composerId: 'tab-2', windowId: 'w1', title: '同名会话', sameTitleIndex: 2 });

    assert.equal(pendingMatchesTab(p, r, 'w2'), false);
  });

  it('同名的另一行（序号不同）不会被误认', () => {
    const r = tab({ composerId: 'tab-3', windowId: 'w1', title: '同名会话', sameTitleIndex: 3 });
    const p = pending({ composerId: 'tab-2', windowId: 'w1', title: '同名会话', sameTitleIndex: 2 });

    assert.equal(pendingMatchesTab(p, r, 'w1'), false);
  });

  it('真 id 一致就认（位置键过期也能对上）', () => {
    const r = tab({ composerId: 'real-id', windowId: 'w1', title: '同名会话', sameTitleIndex: 0 });
    const p = pending({ composerId: 'real-id', windowId: 'w1', title: '同名会话', sameTitleIndex: 3 });

    assert.equal(pendingMatchesTab(p, r, 'w1'), true);
  });
});
