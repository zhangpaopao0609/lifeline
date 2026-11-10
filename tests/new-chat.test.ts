import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import type { PendingNewChat } from '../packages/web/src/store/ui.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { draftPaneBody, newChatLanded } from '../packages/web/src/lib/new-chat.ts';

/**
 * When is an optimistic "new session" row replaced by the real one?
 *
 * The click paints a synthetic row + empty pane immediately (without it the row appeared 2321ms after the click on
 * the live site). The synthetic row must survive exactly until the IDE state proves *a new* chat exists — and must not
 * be dropped by an extract that reports nothing (that would flash the previous session back for one poll), nor by the
 * state that was already on screen before the click (a second ＋, or the window raise a cross-window ＋ does first).
 */
function pending(overrides: Partial<PendingNewChat> = {}): PendingNewChat {
  return {
    commandId: 'cmd-1',
    ide: 'cursor',
    agentId: 'machine-1',
    windowId: 'w-1',
    baseComposerIds: ['old-id'],
    baseDraftIds: [],
    ...overrides,
  };
}

function state(partial: Partial<CursorState>): CursorState {
  return { connected: true, activeWindowId: 'w-1', ...partial } as CursorState;
}

function tab(overrides: Partial<ChatTab>): ChatTab {
  return { composerId: 'x', title: 't', isActive: false, status: 'idle', selectorPath: '', windowId: 'w-1', ...overrides };
}

describe('optimistic new chat', () => {
  it('does not reconcile before any state arrived', () => {
    assert.equal(newChatLanded(pending(), undefined), false);
  });

  it('keeps the row while the active session has not moved', () => {
    const next = state({ activeComposerId: 'old-id', chatTabs: [tab({ composerId: 'old-id', isActive: true })] });
    assert.equal(newChatLanded(pending(), next), false);
  });

  it('reconciles on a new active draft (drafts have no stable id until the extract reports one)', () => {
    const next = state({
      activeComposerId: 'new-id',
      chatTabs: [
        tab({ composerId: 'old-id', isActive: false }),
        tab({ composerId: 'tab-3', isActive: true, isDraft: true, status: 'active' }),
      ],
    });
    assert.equal(newChatLanded(pending(), next), true);
  });

  it('reconciles on a new active session when the baseline knew the window', () => {
    const next = state({ chatTabs: [tab({ composerId: 'new-id', isActive: true })] });
    assert.equal(newChatLanded(pending(), next), true);
  });

  /**
   * Live regression (2026-11-03): the window raise is reported by window-monitor as a patch that only carries
   * `windows` / `activeWindowId`; `activeComposerId` still belongs to the window we came from. Judging that id as
   * "the new chat" dropped the row 81ms after the click, while the real draft appeared ~200ms later.
   */
  it('ignores the previous window\'s active composer id after a raise', () => {
    const raised = state({
      activeWindowId: 'w-1',
      activeComposerId: 'chat-of-another-window',
      chatTabs: [tab({ composerId: 'chat-of-another-window', isActive: true, windowId: 'w-2' })],
    });
    assert.equal(newChatLanded(pending({ baseComposerIds: [] }), raised), false);
  });

  it('keeps the row while the target window reports no tabs at all', () => {
    const next = state({ activeComposerId: 'old-id', chatTabs: [] });
    assert.equal(newChatLanded(pending({ baseComposerIds: [] }), next), false);
  });

  it('does not read a new active session as landed when the window was never extracted', () => {
    // Same shape as the raise above, but the stale tab is attributed to the target window (no per-tab windowId yet).
    const next = state({ chatTabs: [tab({ composerId: 'some-unknown-chat', isActive: true, windowId: '' })] });
    assert.equal(newChatLanded(pending({ baseComposerIds: [] }), next), false);
  });

  it('keeps the row when the active draft was already there at click time (the second + in a row)', () => {
    const before = pending({ baseComposerIds: ['old-id', 'draft-1'], baseDraftIds: ['draft-1'] });
    const next = state({
      activeComposerId: 'draft-1',
      chatTabs: [tab({ composerId: 'draft-1', isActive: true, isDraft: true, status: 'active' })],
    });
    assert.equal(newChatLanded(before, next), false);
  });

  it('reconciles when a second + really produced another draft', () => {
    const before = pending({ baseComposerIds: ['old-id', 'draft-1'], baseDraftIds: ['draft-1'] });
    const next = state({
      activeComposerId: 'draft-2',
      chatTabs: [tab({ composerId: 'draft-2', isActive: true, isDraft: true, status: 'active' })],
    });
    assert.equal(newChatLanded(before, next), true);
  });

  it('ignores an inactive draft (an older draft row must not clear the new one)', () => {
    const next = state({
      activeComposerId: 'old-id',
      chatTabs: [tab({ composerId: 'tab-2', isActive: false, status: 'draft' })],
    });
    assert.equal(newChatLanded(pending(), next), false);
  });

  it('ignores an active draft in another window', () => {
    const next = state({
      activeComposerId: 'old-id',
      chatTabs: [tab({ composerId: 'tab-4', isActive: true, status: 'draft', windowId: 'w-2' })],
    });
    assert.equal(newChatLanded(pending(), next), false);
  });

  it('finds the window\'s tabs in the per-window cache as well', () => {
    const next = state({
      activeWindowId: 'w-2',
      chatTabs: [tab({ composerId: 'old-id', isActive: true, windowId: 'w-2' })],
      windows: [
        { id: 'w-1', title: 'target', chatTabs: [tab({ composerId: 'tab-9', isActive: true, isDraft: true, windowId: 'w-1' })] },
      ] as CursorState['windows'],
    });
    assert.equal(newChatLanded(pending(), next), true);
  });

  it('falls back to the active window when a tab carries no window id', () => {
    const next = state({
      activeComposerId: 'old-id',
      chatTabs: [tab({ composerId: 'tab-5', isActive: true, isDraft: true, windowId: '' })],
    });
    assert.equal(newChatLanded(pending(), next), true);
  });

  it('matches the Agents-window section when one was requested', () => {
    const inSection = state({
      activeComposerId: 'old-id',
      chatTabs: [tab({ composerId: 'tab-6', isActive: true, isDraft: true, section: 'repo-a' })],
    });
    assert.equal(newChatLanded(pending({ section: 'repo-a' }), inSection), true);
    assert.equal(newChatLanded(pending({ section: 'repo-b' }), inSection), false);
  });
});

describe('draft pane body', () => {
  it('paints nothing before a message was sent from the draft', () => {
    assert.equal(draftPaneBody('cursor:draft-1', undefined), undefined);
    assert.equal(draftPaneBody('cursor:draft-1', []), undefined);
    assert.equal(draftPaneBody('', [{ id: 'pending-send:c1' }]), undefined, '没有 key 就没有可挂的正文');
  });

  it('paints the optimistic bubble as soon as it is echoed', () => {
    const bubble = [{ id: 'pending-send:c1' }];
    assert.equal(draftPaneBody('cursor:draft-1', bubble), bubble);
  });

  /**
   * The twin can land and pop the bubble while the IDE state still reports a draft (session-store-web.test.ts covers
   * that order). Deciding on "has a pending bubble" instead of "body is not empty" would blank the pane at that
   * instant and flash the just-landed message away.
   */
  it('keeps painting after reconcile swapped the bubble for the landed twin', () => {
    const landed = [{ id: 'h1' }];
    assert.equal(draftPaneBody('cursor:draft-1', landed), landed);
  });
});
