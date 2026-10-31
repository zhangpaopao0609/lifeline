import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupCliByCwd } from '../packages/web/src/lib/cli-placement.ts';

function session(cwd: string, sessionId = cwd) {
  return { cwd, sessionId, source: 'cursor-cli' as const };
}

describe('groupCliByCwd', () => {
  it('groups a trailing-slash path with the same directory', () => {
    const placed = groupCliByCwd([
      session('/Users/me/proj/', 'a'),
      session('/Users/me/proj', 'b'),
    ]);
    assert.deepEqual(placed.map(block => block.cwd), ['/Users/me/proj']);
    assert.deepEqual(placed[0]?.rows.map(row => row.sessionId), ['a', 'b']);
  });

  it('keeps different directories in first-seen order', () => {
    const placed = groupCliByCwd([
      session('/tmp/other', 's-other'),
      session('/Users/me/proj', 's1'),
      session('/tmp/other', 's-other-2'),
    ]);
    assert.deepEqual(placed.map(block => [block.cwd, block.rows.map(row => row.sessionId)]), [
      ['/tmp/other', ['s-other', 's-other-2']],
      ['/Users/me/proj', ['s1']],
    ]);
  });
});
