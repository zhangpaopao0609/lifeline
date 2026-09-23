import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSessionId } from '../packages/agent/src/session-lookup.js';

function meta(sessionId: string, title: string, extra?: { isSubagent?: boolean }) {
  return {
    ref: { sessionId },
    title,
    isSubagent: extra?.isSubagent ?? false,
  };
}

describe('resolveSessionId', () => {
  it('returns sessionId when provided without scanning titles', () => {
    assert.equal(
      resolveSessionId([meta('other', 'This chat')], { sessionId: 'given' }),
      'given',
    );
  });

  it('matches a unique parent title', () => {
    assert.equal(
      resolveSessionId(
        [meta('a', 'This chat'), meta('b', 'Other', { isSubagent: true })],
        { tabTitle: 'This chat' },
      ),
      'a',
    );
  });

  it('does not guess when the title is missing or duplicated', () => {
    assert.equal(resolveSessionId([meta('a', 'This chat')], { tabTitle: '' }), null);
    assert.equal(
      resolveSessionId(
        [meta('a', 'Dup'), meta('b', 'Dup')],
        { tabTitle: 'Dup' },
      ),
      null,
    );
  });
});
