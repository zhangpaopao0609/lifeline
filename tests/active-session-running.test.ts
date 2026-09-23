import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import type { PendingSwitch } from '../packages/web/src/store/ui.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isActiveSessionWorking,
  isTabRunning,
  viewedTabOf,
} from '../packages/web/src/store/ides.ts';

/**
 * "Is the viewed session running?" prefers the row-level spinner (IDE sidebar ground truth);
 * live activity is only a fallback for this window's active row.
 * Context: switching to a running session can have agentStatus extinguished by copy-staleness
 * while the sidebar spinner is still going; session-row loading / title state must not
 * disappear (2026-09-15 feedback).
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

describe('isTabRunning', () => {
  it('is true only for the generating row', () => {
    assert.equal(isTabRunning(tab({ status: 'generating' })), true);
    assert.equal(isTabRunning(tab({ status: 'waiting_approval' })), false);
    assert.equal(isTabRunning(tab({ status: 'active' })), false);
    assert.equal(isTabRunning(undefined), false);
  });
});

describe('viewedTabOf', () => {
  const tabs = [
    tab({ composerId: 'c1', title: '一', status: 'generating' }),
    tab({ composerId: 'c2', title: '二', isActive: true }),
  ];

  it('prefers the optimistic switch target', () => {
    assert.equal(viewedTabOf(stateWith(tabs), pending({ composerId: 'c1' }))?.composerId, 'c1');
  });

  it('falls back to the active row', () => {
    assert.equal(viewedTabOf(stateWith(tabs), null)?.composerId, 'c2');
    assert.equal(viewedTabOf(stateWith(tabs), pending({ composerId: 'nope' }))?.composerId, 'c2');
  });
});

describe('isActiveSessionWorking', () => {
  it('is true while the viewed row spins, even when the live status went stale', () => {
    const state = stateWith([tab({ composerId: 'c1', isActive: true, status: 'generating' })], {
      // Long task: copy-staleness extinguished live activity to false/idle, but the sidebar is still spinning
      agentStatus: 'idle',
      agentActivityLive: false,
      agentActivitySource: 'none',
    } as Partial<CursorState>);

    assert.equal(isActiveSessionWorking(state), true);
  });

  it('is true for a running session the optimistic switch is heading to', () => {
    const state = stateWith([
      tab({ composerId: 'c1', isActive: true, status: 'active' }),
      tab({ composerId: 'c2', status: 'generating' }),
    ]);

    assert.equal(isActiveSessionWorking(state, pending({ composerId: 'c2' })), true);
  });

  it('is false for a session that is not running', () => {
    const state = stateWith([
      tab({ composerId: 'c1', isActive: true, status: 'generating' }),
      tab({ composerId: 'c2', status: 'idle' }),
    ]);

    assert.equal(isActiveSessionWorking(state, pending({ composerId: 'c2' })), false);
  });

  it('falls back to the live fields only for the active row in the active window', () => {
    const liveState = stateWith([tab({ composerId: 'c1', isActive: true, status: 'active' })], {
      agentStatus: 'running_tool',
      agentActivityText: '跑命令',
      agentActivityLive: true,
    } as Partial<CursorState>);
    assert.equal(isActiveSessionWorking(liveState), true);

    const otherWindowRow = stateWith(
      [tab({ composerId: 'c1', isActive: false, status: 'active', windowId: 'w2' })],
      { agentStatus: 'running_tool', agentActivityLive: true } as Partial<CursorState>,
    );
    assert.equal(isActiveSessionWorking(otherWindowRow), false);
  });
});
