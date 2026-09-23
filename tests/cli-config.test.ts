import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { includeProcessEnabled } from '../packages/cli/src/config.js';

describe('includeProcessEnabled', () => {
  it('is false when missing, false, or a non-boolean true', () => {
    assert.equal(includeProcessEnabled(null), false);
    assert.equal(includeProcessEnabled(undefined), false);
    assert.equal(includeProcessEnabled({}), false);
    assert.equal(includeProcessEnabled({ includeProcess: false }), false);
    assert.equal(includeProcessEnabled({ includeProcess: 'true' }), false);
    assert.equal(includeProcessEnabled({ includeProcess: 1 }), false);
  });

  it('is true only for boolean true', () => {
    assert.equal(includeProcessEnabled({ includeProcess: true }), true);
  });
});
