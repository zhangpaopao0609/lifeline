import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_STATUS_TEXT,
  isTabUnread,
  targetBarStatusText,
} from '../packages/web/src/store/ides.ts';

/**
 * Top-bar copy must share a source with the left-side spinner.
 *
 * 2026-09-15 probe: the session row was spinning (row-level status=generating) but the top bar
 * said "idle". Root cause: `running ? (activityText || TEXT[agentStatus] || '进行中')` —
 * agentStatus is derived from the transcript and lags to idle on long tasks, and `TEXT.idle = '空闲'`
 * is truthy, so the fallback never runs.
 */

function tab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    composerId: 'c1',
    title: '会话一',
    isActive: true,
    status: 'idle',
    selectorPath: '',
    windowId: 'w1',
    ...overrides,
  };
}

function stateWith(overrides: Partial<CursorState> = {}): CursorState {
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

describe('targetBarStatusText', () => {
  it('does not let a stale idle status overwrite the row-level running signal', () => {
    const state = stateWith({
      chatTabs: [tab({ status: 'generating' })],
      agentStatus: 'idle',
      agentActivityLive: false,
      agentActivityText: null,
    });

    assert.equal(targetBarStatusText(state, true), '进行中');
    assert.notEqual(targetBarStatusText(state, true), AGENT_STATUS_TEXT.idle);
  });

  it('prefers the activity text while running', () => {
    const state = stateWith({ agentStatus: 'idle', agentActivityText: '跑命令' });
    assert.equal(targetBarStatusText(state, true), '跑命令');
  });

  it('uses the live status text while running when the live status is also working', () => {
    const state = stateWith({ agentStatus: 'running_tool', agentActivityLive: true });
    assert.equal(targetBarStatusText(state, true), AGENT_STATUS_TEXT.running_tool);
  });

  it('reports idle only when nothing is running', () => {
    const state = stateWith({ agentStatus: 'idle' });
    assert.equal(targetBarStatusText(state, false), '空闲');
  });

  it('keeps the raw status for unknown values and is empty without state', () => {
    const state = stateWith({ agentStatus: 'weird' as CursorState['agentStatus'] });
    assert.equal(targetBarStatusText(state, false), 'weird');
    assert.equal(targetBarStatusText(undefined, true), '');
    assert.equal(targetBarStatusText(undefined, false), '');
  });

  it('says 已完成 for a row that finished with results still unread', () => {
    // Row-level "finished, not yet seen" (the dot on the IDE session tab): the global status at that
    // moment literally says "idle", so "just finished, result waiting" vs "never running" cannot be told apart.
    const state = stateWith({ chatTabs: [tab({ status: 'unread' })], agentStatus: 'idle' });
    assert.equal(targetBarStatusText(state, false, true), '已完成');
    assert.notEqual(targetBarStatusText(state, false, true), AGENT_STATUS_TEXT.idle);
  });

  it('does not let 已完成 overwrite running or error', () => {
    const state = stateWith({ chatTabs: [tab({ status: 'unread' })] });
    assert.notEqual(targetBarStatusText(state, true, true), '已完成');
    assert.equal(targetBarStatusText(stateWith({ agentStatus: 'error' }), false, true), '出错');
  });

  it('says 等待窗口 when disconnected because the IDE has no window', () => {
    const state = stateWith({
      connected: false,
      cdpIssue: {
        kind: 'no-window',
        scope: 'workbench',
        cdpUrl: 'http://127.0.0.1:9222',
        port: 9222,
        detail: '',
        at: 1,
      },
    });
    assert.equal(targetBarStatusText(state, false), '等待窗口');
  });

  it('uses the issue copy for other disconnected kinds and does not override running', () => {
    const occupied = stateWith({
      connected: false,
      cdpIssue: {
        kind: 'not-cdp',
        scope: 'workbench',
        cdpUrl: 'http://127.0.0.1:9222',
        port: 9222,
        detail: '',
        occupant: 'Google Chrome (pid 65600)',
        notCdpCause: 'http',
        at: 1,
      },
    });
    assert.equal(
      targetBarStatusText(occupied, false),
      '9222 被 Google Chrome (pid 65600) 占着，lifeline 连不上 Cursor。关掉它，或换一个端口',
    );
    assert.equal(
      targetBarStatusText(occupied, false, false, 'CodeBuddy'),
      '9222 被 Google Chrome (pid 65600) 占着，lifeline 连不上 CodeBuddy。关掉它，或换一个端口',
    );

    const waiting = stateWith({
      connected: false,
      agentStatus: 'idle',
      cdpIssue: {
        kind: 'no-window',
        scope: 'workbench',
        cdpUrl: 'http://127.0.0.1:9222',
        port: 9222,
        detail: '',
        at: 1,
      },
    });
    assert.notEqual(targetBarStatusText(waiting, true), '等待窗口');
    assert.equal(targetBarStatusText(waiting, true), '进行中');
  });
});

describe('isTabUnread', () => {
  it('counts only status=unread as 跑完未看（服务端 mapTab 写的字面值）', () => {
    assert.equal(isTabUnread(tab({ status: 'unread' })), true);
    assert.equal(isTabUnread(tab({ status: 'generating' })), false);
    assert.equal(isTabUnread(tab({ status: 'waiting_approval' })), false);
    assert.equal(isTabUnread(null), false);
  });
});
