import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLI_STICK_PX, cliScrollState, distanceFromBottom, tailAppendCount } from '../packages/web/src/lib/cli-scroll.js';

describe('cliScrollState', () => {
  it('at the very bottom follows and hides the jump button', () => {
    assert.deepEqual(cliScrollState({ scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 }), { follow: true, showJump: false });
  });

  it('within the stick distance still follows', () => {
    const m = { scrollTop: 2000 - 600 - CLI_STICK_PX, scrollHeight: 2000, clientHeight: 600 };
    assert.equal(cliScrollState(m).follow, true);
  });

  it('just beyond the stick distance stops following but has no button yet', () => {
    const m = { scrollTop: 2000 - 600 - CLI_STICK_PX - 1, scrollHeight: 2000, clientHeight: 600 };
    assert.deepEqual(cliScrollState(m), { follow: false, showJump: false });
  });

  it('more than one screen up shows the jump button', () => {
    assert.deepEqual(cliScrollState({ scrollTop: 0, scrollHeight: 2000, clientHeight: 600 }), { follow: false, showJump: true });
  });

  it('content shorter than the viewport counts as at the bottom', () => {
    assert.deepEqual(cliScrollState({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 }), { follow: true, showJump: false });
    assert.equal(distanceFromBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 }), 0);
  });
});

describe('tailAppendCount', () => {
  it('counts elements appended after the previous tail', () => {
    assert.equal(tailAppendCount(['a', 'b'], ['a', 'b', 'c', 'd']), 2);
  });

  it('first sync is not new messages', () => {
    assert.equal(tailAppendCount([], ['a', 'b', 'c']), 0);
  });

  it('text streaming into the last element is not new messages', () => {
    assert.equal(tailAppendCount(['a', 'b'], ['a', 'b']), 0);
  });

  it('a wholesale replace (previous tail gone) is not new messages', () => {
    assert.equal(tailAppendCount(['a', 'b'], ['x', 'y', 'z']), 0);
  });

  it('trimming old elements while appending still counts only the appended ones', () => {
    assert.equal(tailAppendCount(['a', 'b', 'c'], ['c', 'd']), 1);
  });
});
