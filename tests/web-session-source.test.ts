import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SESSION_SOURCE_LABEL, sessionSourceIdes } from '../packages/web/src/lib/session-source.ts';

describe('session source rows', () => {
  it('names a read-only IDE row 会话源·只读', () => {
    assert.equal(SESSION_SOURCE_LABEL, '会话源·只读');
  });

  it('lists only IDEs that have sessions, in rail order', () => {
    assert.deepEqual(sessionSourceIdes(undefined), []);
    assert.deepEqual(sessionSourceIdes([]), []);
    assert.deepEqual(sessionSourceIdes(['codebuddy']), ['codebuddy']);
    assert.deepEqual(sessionSourceIdes(['codebuddy', 'cursor']), ['cursor', 'codebuddy']);
    assert.deepEqual(sessionSourceIdes(['cursor', 'not-an-ide']), ['cursor']);
  });
});
