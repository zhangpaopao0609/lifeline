import type { ScrollSample } from '../packages/web/src/lib/scroll-jump.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectScrollJump } from '../packages/web/src/lib/scroll-jump.js';

function s(t: number, st: number, key: string, elId: number, elTop: number, sh = 100000, n = 20): ScrollSample {
  return { t, st, sh, n, key, elId, elTop };
}

/** Segment order: a9 < a10 < a11 (key → segment index in the full body) */
const order = new Map([
  ['a9', 9],
  ['a10', 10],
  ['a11', 11],
  ['a12', 12],
]);

describe('detectScrollJump', () => {
  it('catches the visible block sliding down inside the same item', () => {
    // Same message + same block: content above it grew 100px (the iOS case where nobody compensates)
    const prev = s(1, 5000, 'a11', 7, 4800);
    const cur = s(2, 5010, 'a11', 7, 4900);
    const jump = detectScrollJump(prev, cur, order);
    assert.equal(jump?.kind, 'content');
    assert.equal(jump?.key, 'a11');
    assert.equal(jump?.from.elTop, 4800);
    assert.equal(jump?.to.elTop, 4900);
  });

  it('keeps normal scrolling inside one item quiet (block moves up)', () => {
    assert.equal(detectScrollJump(s(1, 5000, 'a11', 7, 4800), s(2, 5200, 'a11', 7, 4600), order), null);
  });

  it('ignores pixel-level noise', () => {
    assert.equal(detectScrollJump(s(1, 5000, 'a11', 7, 4800), s(2, 5005, 'a11', 7, 4790), order), null);
  });

  it('catches the view falling back onto an earlier block', () => {
    const jump = detectScrollJump(s(1, 5000, 'a11', 7, 4800), s(2, 5010, 'a11', 8, 4300), order);
    assert.equal(jump?.kind, 'back');
  });

  it('catches the top item snapping back to an earlier one', () => {
    const jump = detectScrollJump(s(1, 5000, 'a11', 7, 4800), s(2, 5200, 'a10', 9, 5200), order);
    assert.equal(jump?.kind, 'item');
    assert.equal(jump?.key, 'a10');
  });

  it('treats advancing to the next item as normal scrolling', () => {
    assert.equal(detectScrollJump(s(1, 4400, 'a10', 7, 4400), s(2, 4800, 'a11', 8, 4800), order), null);
  });

  it('ignores a fallback while scrolling up (that is just reading history)', () => {
    assert.equal(detectScrollJump(s(1, 5000, 'a11', 7, 4800), s(2, 4200, 'a9', 9, 4000), order), null);
  });

  it('ignores samples without a landmark element', () => {
    assert.equal(detectScrollJump(s(1, 0, '', 0, -1), s(2, 10, '', 0, -1), order), null);
  });
});
