import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDraftTab, liveSessionKeyOf } from '../packages/web/src/store/ides.ts';

/**
 * 2026-09-18 feedback: "creating a session in Cursor's Agents window, the session UI still keeps the previous session's records".
 *
 * Root cause: Agents-window drafts have **no composerId** (the main pane has no `data-composer-id` on the page),
 * so the extractor can only report `activeComposerId` empty, while the web client still holds the **previous**
 * session — the body is then loaded from that previous one.
 * Constraint: a draft (the kind with no real id) must have an empty body key so the UI draws "new session"
 * rather than old body; a project-window ＋-created draft has its own composerId and is loaded by that id
 * (which is empty anyway), so a false isDraft in occlusion edge cases will not hide a real session's body.
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

describe('isDraftTab', () => {
  it('行状态点（Agents 窗口）与 isDraft（项目窗口点 ＋）都算草稿', () => {
    assert.equal(isDraftTab(tab({ status: 'draft' })), true);
    assert.equal(isDraftTab(tab({ isDraft: true })), true);
    assert.equal(isDraftTab(tab({ status: 'active' })), false);
    assert.equal(isDraftTab(undefined), false);
    assert.equal(isDraftTab(null), false);
  });
});

describe('liveSessionKeyOf（草稿不顶上一条会话的正文）', () => {
  it('没有真 id 的草稿：键为空（activeComposerId 还指着上一条也不认）', () => {
    const state = stateWith(
      [tab({ composerId: 'tab-2', title: '谢谢', status: 'draft', isActive: true })],
      { activeComposerId: 'c-old' },
    );
    assert.equal(liveSessionKeyOf('cursor', state), '');
  });

  it('有真 id 的草稿：键也为空——它还没落盘，正文请求必然石沉大海（2026-09-20）', () => {
    const state = stateWith([
      tab({ composerId: 'c-draft', title: 'New Agent', isDraft: true, isActive: true }),
    ]);
    // The draft UI is expressed by Timeline's draft hint; after the first message is persisted, liveKey naturally switches to the real session
    assert.equal(liveSessionKeyOf('cursor', state), '');
  });

  it('普通会话照旧', () => {
    const normal = stateWith([tab({ composerId: 'c1', isActive: true })]);
    assert.equal(liveSessionKeyOf('cursor', normal), 'cursor:c1');
  });

  it('点草稿行（占位 id）的乐观切换中：先按位置键认出这条草稿，别闪一下上一条的正文', () => {
    const switching = stateWith(
      [
        tab({ composerId: 'c1', isActive: true }),
        tab({ composerId: 'tab-3', title: 'New Agent', status: 'draft', sameTitleIndex: 0 }),
      ],
      { activeComposerId: 'c1' },
    );
    assert.equal(
      liveSessionKeyOf('cursor', switching, {
        commandId: 'cmd-1',
        ide: 'cursor',
        composerId: 'tab-3',
        windowId: 'w1',
        title: 'New Agent',
        sameTitleIndex: 0,
        startedAt: 0,
      }),
      '',
    );
  });

  it('占位 id 正好就是那一行时，直接按 id 认出（草稿行最常见的现场）', () => {
    const switching = stateWith(
      [
        tab({ composerId: 'c1', isActive: true }),
        tab({ composerId: 'tab-3', title: 'New Agent', status: 'draft' }),
      ],
      { activeComposerId: 'c1' },
    );
    assert.equal(
      liveSessionKeyOf('cursor', switching, {
        commandId: 'cmd-1',
        ide: 'cursor',
        composerId: 'tab-3',
        windowId: 'w1',
        title: 'New Agent',
        startedAt: 0,
      }),
      '',
    );
  });

  it('位置键只认草稿行：普通会话拿了占位 id（抽取没对齐）也不改判，免得把真正文判成没有', () => {
    const switching = stateWith(
      [
        tab({ composerId: 'c1', isActive: true }),
        // A same-name same-index row in the same window — but it is not a draft, so the position key must not treat it as the switch target
        tab({ composerId: 'tab-4', title: 'New Agent' }),
      ],
      { activeComposerId: 'c1' },
    );
    assert.equal(
      liveSessionKeyOf('cursor', switching, {
        commandId: 'cmd-1',
        ide: 'cursor',
        composerId: 'tab-9',
        windowId: 'w1',
        title: 'New Agent',
        sameTitleIndex: 0,
        startedAt: 0,
      }),
      'cursor:c1',
    );
  });

  it('行都对不上（老客户端不带同名序号、占位 id 也漂了）时回落到活跃行', () => {
    const switching = stateWith(
      [
        tab({ composerId: 'c1', isActive: true }),
        tab({ composerId: 'tab-3', title: 'New Agent', status: 'draft' }),
      ],
      { activeComposerId: 'c1' },
    );
    assert.equal(
      liveSessionKeyOf('cursor', switching, {
        commandId: 'cmd-1',
        ide: 'cursor',
        composerId: 'tab-9',
        windowId: 'w1',
        title: '别的会话',
        startedAt: 0,
      }),
      'cursor:c1',
    );
  });
});
