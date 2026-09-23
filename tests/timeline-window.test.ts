import type { ChatElement } from '../packages/protocol/src/index.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { segmentsPrepended } from '../packages/web/src/lib/timeline-window.js';

function human(id: string): ChatElement {
  return { type: 'human', id, flatIndex: 0, text: id, mentions: [] };
}

function assistant(id: string): ChatElement {
  return { type: 'assistant', id, flatIndex: 0, text: id };
}

function tool(id: string): ChatElement {
  return {
    type: 'tool',
    id,
    flatIndex: 0,
    toolCallId: id,
    status: 'completed',
    action: 'ran',
    details: id,
  };
}

describe('segmentsPrepended', () => {
  it('counts segments, not elements (consecutive tools are one segment)', () => {
    // Previous page: assistant + a run of tools + assistant; local first item is a2
    const body = [assistant('p1'), tool('p2'), tool('p3'), tool('p4'), assistant('a2'), human('a3')];
    // Segments: p1 | p2..p4 | a2 | a3 → 2 segments before a2
    assert.equal(segmentsPrepended(body, 'a2'), 2);
  });

  it('merges the boundary tool run into a single segment', () => {
    // Prefix ends on a tool and the local first item is also a tool: they share a segment (key is the first of the run)
    const body = [assistant('p1'), tool('p2'), tool('a2'), assistant('a3')];
    // Segments: p1 | p2,a2 | a3 → a2 is in segment 1, offset 1 (not 2)
    assert.equal(segmentsPrepended(body, 'a2'), 1);
  });

  it('is zero when nothing was prepended', () => {
    const body = [assistant('a1'), assistant('a2')];
    assert.equal(segmentsPrepended(body, 'a1'), 0);
  });

  it('is zero when the previous head is gone (authoritative full replace)', () => {
    const body = [assistant('x1'), assistant('x2')];
    assert.equal(segmentsPrepended(body, 'a1'), 0);
  });

  it('is zero without a remembered head (first frame / after a session switch)', () => {
    const body = [assistant('a1'), assistant('a2')];
    assert.equal(segmentsPrepended(body, ''), 0);
  });

  it('regression: a tool-heavy page must not shift the window by its element count', () => {
    // Previous page: 59-item tool run + 1 overlap (local first item) → 59 elements, only 1 segment
    const page: ChatElement[] = [];
    for (let i = 0; i < 59; i += 1) page.push(tool(`p${i}`));
    const body = [...page, assistant('local-head'), human('local-2')];
    assert.equal(segmentsPrepended(body, 'local-head'), 1);
    assert.notEqual(segmentsPrepended(body, 'local-head'), page.length);
  });
});
