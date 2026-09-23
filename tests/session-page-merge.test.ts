import type { ChatElement } from '../packages/protocol/src/index.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeById, mergeEarlierPage, mergeTailPage } from '../packages/web/src/lib/session-page.js';

function a(id: string, flatIndex: number, text = id): ChatElement {
  return { type: 'assistant', id, flatIndex, text };
}

describe('mergeById', () => {
  it('replaces in place and appends new ids at the end', () => {
    const out = mergeById([a('x', 0), a('y', 1)], [a('y', 1, 'Y2'), a('z', 2)]);
    assert.deepEqual(out.map(m => m.id), ['x', 'y', 'z']);
    assert.equal((out[1] as { text: string }).text, 'Y2');
  });
});

describe('mergeTailPage', () => {
  it('keeps the older prefix when the page starts inside the local body', () => {
    const local = [a('a1', 0), a('a2', 1), a('a3', 2), a('a4', 3)];
    const out = mergeTailPage(local, [a('a3', 2, 'A3new'), a('a4', 3), a('a5', 4)]);
    assert.deepEqual(out?.map(m => m.id), ['a1', 'a2', 'a3', 'a4', 'a5']);
    assert.equal((out![2] as { text: string }).text, 'A3new');
  });

  it('drops local tail elements the page does not carry', () => {
    const local = [a('a1', 0), a('a2', 1), a('a3', 2)];
    const out = mergeTailPage(local, [a('a2', 1)]);
    assert.deepEqual(out?.map(m => m.id), ['a1', 'a2']);
  });

  it('returns null when the boundary is unknown so the caller replaces', () => {
    assert.equal(mergeTailPage([a('a1', 0)], [a('zz', 9)]), null);
    assert.equal(mergeTailPage([], [a('zz', 9)]), null);
    assert.equal(mergeTailPage([a('a1', 0)], []), null);
  });
});

describe('mergeEarlierPage', () => {
  it('prepends the missing elements and reports how many were added', () => {
    // Closed interval: the previous page's last item is the overlap token (local first item), matching Task 2's lte(before)
    const local = [a('a3', 2), a('a4', 3)];
    const out = mergeEarlierPage(local, [a('a1', 0), a('a2', 1), a('a3', 2)]);
    assert.deepEqual(out?.body.map(m => m.id), ['a1', 'a2', 'a3', 'a4']);
    assert.equal(out?.headAdded, 2);
  });

  it('counts zero when the page is already fully known', () => {
    const local = [a('a1', 0), a('a2', 1)];
    const out = mergeEarlierPage(local, [a('a1', 0)]);
    assert.equal(out?.headAdded, 0);
    assert.deepEqual(out?.body.map(m => m.id), ['a1', 'a2']);
  });

  it('returns null when the page does not touch the local body', () => {
    assert.equal(mergeEarlierPage([a('a5', 4)], [a('a1', 0), a('a2', 1)]), null);
    assert.equal(mergeEarlierPage([a('a5', 4)], []), null);
  });
});
