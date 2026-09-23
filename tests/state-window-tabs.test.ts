import type { ChatTab, CursorWindow } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeWindowChatTabs, StateManager } from '../packages/agent/src/state-manager.js';

function tab(title: string, windowId: string): ChatTab {
  return { composerId: `c-${title}`, title, isActive: true, status: 'idle', selectorPath: 'sp', windowId };
}

function win(id: string, extra: Partial<CursorWindow> = {}): CursorWindow {
  return { id, title: id, url: `file:///${id}`, ...extra };
}

describe('mergeWindowChatTabs', () => {
  it('keeps previously extracted sidebars when the CDP list has none', () => {
    const prev = [win('a', { chatTabs: [tab('A chat', 'a')] }), win('b')];
    const next = [win('a'), win('b')];
    const merged = mergeWindowChatTabs(prev, next);
    assert.equal(merged[0].chatTabs?.[0].title, 'A chat');
    assert.equal(merged[1].chatTabs, undefined);
  });

  it('does not replace a fresh sidebar with an empty extract', () => {
    const prev = [win('a', { chatTabs: [tab('Old', 'a')] })];
    const next = [win('a', { chatTabs: [tab('New', 'a')] })];
    assert.equal(mergeWindowChatTabs(prev, next)[0].chatTabs?.[0].title, 'New');
  });
});

describe('StateManager window chatTabs', () => {
  it('preserves other-window tabs across updateWindows', () => {
    const sm = new StateManager(10);
    sm.updateWindows([
      win('home'),
      win('other', { chatTabs: [tab('Other chat', 'other')] }),
    ], 'home');
    sm.updateWindows([win('home'), win('other')], 'home');
    assert.equal(sm.getCurrentState().windows[1].chatTabs?.[0].title, 'Other chat');
  });

  it('patches one window\'s tabs without dropping the list', () => {
    const sm = new StateManager(10);
    const patches: unknown[] = [];
    sm.on('state:patch', p => patches.push(p));
    sm.updateWindows([win('home'), win('other')], 'home');
    sm.updateWindowChatTabs('other', [tab('Arrived', 'other')]);
    assert.equal(sm.getCurrentState().windows[1].chatTabs?.[0].title, 'Arrived');
    const last = patches[patches.length - 1] as { windows?: CursorWindow[] };
    assert.equal(last.windows?.[1].chatTabs?.[0].title, 'Arrived');
  });

  it('ignores an empty extract so a background poll cannot wipe the sidebar', () => {
    const sm = new StateManager(10);
    sm.updateWindows([win('other', { chatTabs: [tab('Keep', 'other')] })], 'other');
    sm.updateWindowChatTabs('other', []);
    assert.equal(sm.getCurrentState().windows[0].chatTabs?.[0].title, 'Keep');
  });
});
