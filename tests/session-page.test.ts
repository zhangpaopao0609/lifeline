import type { ChatElement } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tailPage } from '../packages/server/src/pages/session-page.js';

function body(n: number): ChatElement[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'assistant' as const,
    id: `a${i}`,
    flatIndex: i,
    text: `${i}`,
  }));
}

describe('tailPage', () => {
  it('returns the whole body when it fits in one page', () => {
    const page = tailPage(body(3), 200);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextBefore, undefined);
    assert.deepEqual(page.messages.map(m => m.id), ['a0', 'a1', 'a2']);
  });

  it('keeps the last page and points nextBefore at its first flatIndex', () => {
    const page = tailPage(body(450), 200);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, 250);
    assert.equal(page.messages.length, 200);
    assert.equal(page.messages[0].id, 'a250');
    assert.equal(page.messages[199].id, 'a449');
  });

  it('treats an exactly-full body as a complete page', () => {
    const page = tailPage(body(200), 200);
    assert.equal(page.hasMore, false);
    assert.equal(page.messages.length, 200);
  });
});
