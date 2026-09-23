import type { SessionMeta } from '../packages/agent/src/sources/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SessionIndexMerger } from '../packages/agent/src/sources/merge-index.js';

function meta(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    ref: { ide: 'cursor', workspaceId: 'ws', sessionId: 's1' },
    title: 'T',
    createdAt: 1,
    lastUpdatedAt: 2,
    isArchived: false,
    isSubagent: false,
    status: 'idle',
    messageCount: 1,
    ...extra,
  };
}

describe('SessionIndexMerger', () => {
  it('merges ticked ides by lastUpdatedAt and omits unticked ones', () => {
    const m = new SessionIndexMerger();
    m.set('cursor', [meta({ ref: { ide: 'cursor', workspaceId: 'w', sessionId: 'c' }, lastUpdatedAt: 2 })]);
    const once = m.set('codebuddy', [meta({ ref: { ide: 'codebuddy', workspaceId: 'w', sessionId: 'b' }, lastUpdatedAt: 9, title: 'B' })]);
    assert.equal(once[0].title, 'B');
    assert.equal(once.length, 2);
    m.set('cursor', []); // cursor is now empty; codebuddy remains
    assert.equal(m.get().some(s => s.ref.ide === 'codebuddy'), true);
    assert.equal(m.get().some(s => s.ref.ide === 'cursor'), false);
  });

  it('keeps an empty set() ide in the reported set', () => {
    const m = new SessionIndexMerger();
    m.set('cursor', []);
    m.set('codebuddy', [meta({ ref: { ide: 'codebuddy', workspaceId: 'w', sessionId: 'b' }, lastUpdatedAt: 9 })]);
    const reported = m.reportedIdes();
    assert.equal(reported.includes('cursor'), true);
    assert.equal(reported.includes('codebuddy'), true);
  });
});
