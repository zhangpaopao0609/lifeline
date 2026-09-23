import type { ChatTab } from '../packages/web/src/net/protocol.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  groupTabsBySection,
  groupTabsByWindow,
  loadSavedOrder,
  mergeIncoming,
  orderGroups,
  reorderIds,
  saveOrder,
  storageKey,
  WINDOW_ORDER_PREFIX,
} from '../packages/web/src/lib/window-order.ts';

describe('mergeIncoming', () => {
  it('returns incoming when nothing is pinned', () => {
    assert.deepEqual(mergeIncoming([], ['b', 'a']), ['b', 'a']);
  });

  it('keeps pinned order when active window moves to the front of incoming', () => {
    assert.deepEqual(mergeIncoming(['a', 'b', 'c'], ['c', 'a', 'b']), ['a', 'b', 'c']);
  });

  it('appends newly seen ids at the end', () => {
    assert.deepEqual(mergeIncoming(['a', 'b'], ['b', 'a', 'd']), ['a', 'b', 'd']);
  });

  it('drops ids that disappeared', () => {
    assert.deepEqual(mergeIncoming(['a', 'b', 'c'], ['c', 'a']), ['a', 'c']);
  });
});

describe('reorderIds', () => {
  it('moves a window in front of another', () => {
    assert.deepEqual(reorderIds(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  });

  it('is a no-op for unknown ids', () => {
    assert.deepEqual(reorderIds(['a', 'b'], 'x', 'a'), ['a', 'b']);
  });
});

describe('localStorage helpers', () => {
  it('builds a per-machine per-ide key', () => {
    assert.equal(storageKey('m1', 'cursor'), `${WINDOW_ORDER_PREFIX}m1:cursor`);
  });

  it('returns null when the user has never dragged', () => {
    const storage = { getItem: () => null };
    assert.equal(loadSavedOrder(storage, 'k'), null);
  });

  it('round-trips a dragged order', () => {
    const bag: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => bag[k] ?? null,
      setItem: (k: string, v: string) => {
        bag[k] = v;
      },
    };
    saveOrder(storage, 'k', ['w2', 'w1']);
    assert.deepEqual(loadSavedOrder(storage, 'k'), ['w2', 'w1']);
  });
});

describe('groupTabsByWindow', () => {
  const tab = (title: string, windowId: string, extra?: Partial<ChatTab>): ChatTab => ({
    composerId: `${windowId}-${title}`,
    title,
    isActive: false,
    status: 'idle',
    selectorPath: '',
    windowId,
    ...extra,
  });

  it('does not put the active window first just because chatTabs belong to it', () => {
    const groups = groupTabsByWindow({
      activeWindowId: 'w2',
      chatTabs: [tab('live', 'w2', { isActive: true })],
      windows: [
        { id: 'w1', title: 'alpha', url: '', chatTabs: [tab('old', 'w1')] },
        { id: 'w2', title: 'beta', url: '', chatTabs: [tab('live', 'w2', { isActive: true })] },
      ],
    });
    assert.deepEqual(groups.map(g => g.windowId), ['w1', 'w2']);
  });
});

describe('orderGroups', () => {
  it('applies a saved order without following incoming shuffle', () => {
    const groups = [
      { windowId: 'w2', title: 'b', tabs: [] },
      { windowId: 'w1', title: 'a', tabs: [] },
    ];
    assert.deepEqual(orderGroups(groups, ['w1', 'w2']).map(g => g.windowId), ['w1', 'w2']);
  });
});

/**
 * Agents-window rows (Cursor's global agent list) carry a section: the web UI draws secondary
 * subsections by repo. Merge only **adjacent** same-section rows: the IDE row order is ground
 * truth; do not pull distant same-named subsections together.
 */
describe('groupTabsBySection', () => {
  const tab = (title: string, section?: string): ChatTab => ({
    composerId: title,
    title,
    isActive: false,
    status: 'idle',
    selectorPath: '',
    ...(section === undefined ? {} : { section }),
  });

  it('groups adjacent tabs by section and keeps the IDE order', () => {
    const sections = groupTabsBySection([
      tab('a', 'repo/one'),
      tab('b', 'repo/one'),
      tab('c', 'repo/two'),
      tab('d', 'repo/one'),
    ]);
    assert.deepEqual(sections.map(s => s.section), ['repo/one', 'repo/two', 'repo/one']);
    assert.deepEqual(sections.map(s => s.tabs.map(t => t.title)), [['a', 'b'], ['c'], ['d']]);
  });

  it('treats missing section as its own bucket (项目窗口的行没有 section)', () => {
    const sections = groupTabsBySection([tab('a'), tab('b', 'repo/one'), tab('c')]);
    assert.deepEqual(sections.map(s => s.section), ['', 'repo/one', '']);
    assert.deepEqual(sections.map(s => s.tabs.length), [1, 1, 1]);
  });

  it('returns nothing for an empty list', () => {
    assert.deepEqual(groupTabsBySection([]), []);
  });
});
