import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffLines } from '../packages/agent/src/sources/diff.js';

describe('diffLines', () => {
  it('marks a changed middle line', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    const kinds = ops.map(o => `${o.kind}:${o.text}`);
    assert.ok(kinds.includes('rem:b'));
    assert.ok(kinds.includes('add:B'));
  });

  it('returns empty when equal', () => {
    assert.equal(diffLines('x\n', 'x\n').length, 0);
  });
});
