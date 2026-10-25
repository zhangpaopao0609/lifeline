import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatThoughtDuration, thoughtHeader } from '../packages/web/src/lib/thought-label.js';

describe('thought header', () => {
  it('turns millisecond durations into Cursor-style labels', () => {
    assert.equal(formatThoughtDuration('1000ms'), '1s');
    assert.equal(formatThoughtDuration('10ms'), 'briefly');
    assert.equal(formatThoughtDuration('18000ms'), '18s');
    assert.equal(formatThoughtDuration(''), '');
    assert.equal(formatThoughtDuration('2s'), '2s');
  });

  it('keeps the thinking body out of the collapsed header', () => {
    const header = thoughtHeader({
      duration: '1000ms',
      detail: '用户希望直接调用充值接口来完成可用额度的发放。',
    });
    assert.equal(header, 'Thought 1s');
    assert.equal(header.includes('充值'), false);
  });

  it('uses a short action as the label when one is present', () => {
    assert.equal(thoughtHeader({ action: 'Planning', duration: '2000ms', detail: 'long' }), 'Planning 2s');
  });

  it('says Thinking when there is nothing to show yet', () => {
    assert.equal(thoughtHeader({ duration: '', detail: '' }), 'Thinking');
  });
});
