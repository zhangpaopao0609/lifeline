import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import type { PendingSwitch } from '../packages/web/src/store/ui.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { draftSessionKeyOf } from '../packages/web/src/store/ides.ts';

/**
 * Where does the first message sent from a draft hang its optimistic bubble?
 *
 * `liveSessionKeyOf` is '' for a draft on purpose (no body to fetch), so before this key existed the bubble was
 * echoed into nothing the pane would ever render: Cursor's first message stayed invisible for the 1–2s until the
 * IDE persisted the session and the live key caught up. CodeBuddy never reports drafts, which is why only Cursor
 * looked broken.
 *
 * The rule is narrow on purpose: **only the draft's own composer id counts**. For a draft whose row id is still a
 * placeholder (`tab-N`), `activeComposerId` still belongs to the previous session — borrowing it would paint the
 * bubble into another session's body and make the draft pane render that session's history, which is exactly the
 * 2026-09-18 regression `liveSessionKeyOf` short-circuits drafts for (tests/web-draft-session.test.ts).
 */
function state(partial: Partial<CursorState>): CursorState {
  return { connected: true, activeWindowId: 'w-1', ...partial } as CursorState;
}

function tab(overrides: Partial<ChatTab>): ChatTab {
  return { composerId: 'x', title: 't', isActive: false, status: 'idle', selectorPath: '', windowId: 'w-1', ...overrides };
}

describe('draft optimistic bubble key', () => {
  it('keys on the draft\'s own composer id (the key the persisted session will use)', () => {
    // Project-window ＋: the extractor synthesizes the draft row from the composer's real container id.
    const next = state({
      activeComposerId: 'draft-1',
      chatTabs: [tab({ composerId: 'draft-1', isActive: true, isDraft: true, status: 'active' })],
    });
    assert.equal(draftSessionKeyOf('cursor', next), 'cursor:draft-1');
  });

  it('gives no key when the draft row is still a placeholder — never borrow the previous session', () => {
    // Agents-window draft without `data-sidebar-item-key`: no id anywhere, and `activeComposerId` is still `c-old`
    // (sanitizeIncomingLive drops the empty incoming value on a patch, so the stale id survives). Such a draft keeps
    // the pre-fix 1–2s wait: there is nothing the bubble could join, and the wrong key is worse than a short wait.
    const next = state({
      activeComposerId: 'c-old',
      chatTabs: [tab({ composerId: 'tab-3', isActive: true, isDraft: true, status: 'draft' })],
    });
    assert.equal(draftSessionKeyOf('cursor', next), '');
  });

  it('gives no key without state', () => {
    assert.equal(draftSessionKeyOf('cursor', undefined), '');
  });

  it('prefers the draft being switched to over the still-active previous session', () => {
    const next = state({
      activeComposerId: 'old-id',
      chatTabs: [
        tab({ composerId: 'old-id', isActive: true }),
        tab({ composerId: 'draft-2', isActive: false, isDraft: true, status: 'draft' }),
      ],
    });
    const pending: PendingSwitch = {
      commandId: 'cmd-1',
      ide: 'cursor',
      composerId: 'draft-2',
      windowId: 'w-1',
      title: '新会话',
      startedAt: 0,
    };
    assert.equal(draftSessionKeyOf('cursor', next, pending), 'cursor:draft-2');
  });

  it('gives no key when switching to a placeholder-id draft row', () => {
    const next = state({
      activeComposerId: 'old-id',
      chatTabs: [
        tab({ composerId: 'old-id', isActive: true }),
        tab({ composerId: 'tab-3', title: 'New Agent', status: 'draft', sameTitleIndex: 0 }),
      ],
    });
    const pending: PendingSwitch = {
      commandId: 'cmd-2',
      ide: 'cursor',
      composerId: 'tab-3',
      windowId: 'w-1',
      title: 'New Agent',
      sameTitleIndex: 0,
      startedAt: 0,
    };
    assert.equal(draftSessionKeyOf('cursor', next, pending), '');
  });
});
