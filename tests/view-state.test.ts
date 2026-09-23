import type { ChatTab, CursorState } from '../packages/web/src/net/protocol.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findTabByComposerId,
  formatViewQuery,
  parseViewQuery,
  readStoredView,
  resolveInitialView,
  VIEW_STORAGE_KEY,
  writeStoredView,
} from '../packages/web/src/lib/view-state.ts';

function memoryStorage(seed: Record<string, string> = {}) {
  const bag = { ...seed };
  return {
    getItem: (k: string) => bag[k] ?? null,
    setItem: (k: string, v: string) => {
      bag[k] = v;
    },
    raw: bag,
  };
}

function state(partial: Partial<CursorState>): CursorState {
  return partial as CursorState;
}

function tab(composerId: string, title: string, extra?: Partial<ChatTab>): ChatTab {
  return { composerId, title, isActive: false, status: 'idle', selectorPath: '', ...extra };
}

describe('view query', () => {
  it('round-trips machine + ide + session', () => {
    const query = formatViewQuery({ agentId: 'mac-1', ide: 'codebuddy', sessionId: 'composer-9' });
    assert.equal(query, '?m=mac-1&ide=codebuddy&s=composer-9');
    assert.deepEqual(parseViewQuery(query), { agentId: 'mac-1', ide: 'codebuddy', sessionId: 'composer-9' });
  });

  it('escapes ids that would break the query', () => {
    const query = formatViewQuery({ agentId: 'a b&c', ide: 'cursor', sessionId: 'x=y' });
    assert.deepEqual(parseViewQuery(query), { agentId: 'a b&c', ide: 'cursor', sessionId: 'x=y' });
  });

  it('drops unknown fields and unknown ides', () => {
    assert.deepEqual(parseViewQuery('?m=mac-1&ide=vscode&zzz=1'), { agentId: 'mac-1' });
  });

  it('returns nothing for an empty query', () => {
    assert.deepEqual(parseViewQuery(''), {});
    assert.deepEqual(parseViewQuery('?'), {});
    assert.equal(formatViewQuery({}), '');
  });
});

describe('stored view', () => {
  it('returns nothing when the user has never opened the page', () => {
    assert.deepEqual(readStoredView(memoryStorage()), {});
  });

  it('round-trips a view', () => {
    const storage = memoryStorage();
    writeStoredView(storage, { agentId: 'mac-1', ide: 'cursor', sessionId: 'c1' });
    assert.deepEqual(readStoredView(storage), { agentId: 'mac-1', ide: 'cursor', sessionId: 'c1' });
  });

  it('survives garbage in localStorage', () => {
    assert.deepEqual(readStoredView(memoryStorage({ [VIEW_STORAGE_KEY]: '{not json' })), {});
    assert.deepEqual(readStoredView(memoryStorage({ [VIEW_STORAGE_KEY]: '{"ide":"nope"}' })), {});
  });
});

describe('resolveInitialView', () => {
  it('prefers the query so a shared /console link wins over this browser history', () => {
    const storage = memoryStorage();
    writeStoredView(storage, { agentId: 'mac-old', ide: 'cursor', sessionId: 'c-old' });
    assert.deepEqual(resolveInitialView('?m=mac-2&ide=codebuddy&s=c2', storage), {
      agentId: 'mac-2',
      ide: 'codebuddy',
      sessionId: 'c2',
    });
  });

  it('falls back to localStorage when the URL carries no view', () => {
    const storage = memoryStorage();
    writeStoredView(storage, { agentId: 'mac-1', ide: 'codebuddy', sessionId: 'c1' });
    assert.deepEqual(resolveInitialView('', storage), { agentId: 'mac-1', ide: 'codebuddy', sessionId: 'c1' });
  });

  it('does not mix a query machine with a stored session', () => {
    const storage = memoryStorage();
    writeStoredView(storage, { agentId: 'mac-old', ide: 'cursor', sessionId: 'c-old' });
    assert.deepEqual(resolveInitialView('?m=mac-2', storage), { agentId: 'mac-2' });
  });
});

describe('findTabByComposerId', () => {
  it('finds a tab in the global list', () => {
    const s = state({ activeWindowId: 'w1', chatTabs: [tab('c1', 'alpha', { windowId: 'w1' })] });
    assert.equal(findTabByComposerId(s, 'c1')?.title, 'alpha');
  });

  it('finds a tab in a non-home window and stamps its windowId', () => {
    const s = state({
      activeWindowId: 'w1',
      chatTabs: [],
      windows: [{ id: 'w2', title: 'beta', url: '', chatTabs: [tab('c2', 'gamma')] }],
    });
    assert.equal(findTabByComposerId(s, 'c2')?.windowId, 'w2');
  });

  it('returns null when the session is gone', () => {
    const s = state({ activeWindowId: 'w1', chatTabs: [tab('c1', 'alpha')], windows: [] });
    assert.equal(findTabByComposerId(s, 'nope'), null);
    assert.equal(findTabByComposerId(undefined, 'c1'), null);
  });
});
