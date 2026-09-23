import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyIdePatch,
  parseIde,
  wrapIncomingFull,
} from '../packages/server/src/ide.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';

describe('ide wire', () => {
  it('parseIde defaults unknown to cursor', () => {
    assert.equal(parseIde('codebuddy'), 'codebuddy');
    assert.equal(parseIde('cursor'), 'cursor');
    assert.equal(parseIde(undefined), 'cursor');
    assert.equal(parseIde('vscode'), 'cursor');
  });

  it('wraps a legacy CursorState as the cursor slot', () => {
    const raw = emptyCursorState();
    raw.agentStatus = 'generating';
    const wrapped = wrapIncomingFull(raw);
    assert.equal(wrapped.ides.cursor?.agentStatus, 'generating');
    assert.equal(wrapped.ides.codebuddy, undefined);
  });

  it('passes through { ides }', () => {
    const wrapped = wrapIncomingFull({
      ides: { codebuddy: emptyCursorState() },
    });
    assert.equal(wrapped.ides.cursor, undefined);
    assert.ok(wrapped.ides.codebuddy);
  });

  it('applyIdePatch does not copy fields onto the other ide', () => {
    const prev = wrapIncomingFull({
      ides: { cursor: emptyCursorState(), codebuddy: emptyCursorState() },
    });
    const next = applyIdePatch(prev, 'codebuddy', { agentStatus: 'generating' });
    assert.equal(next.ides.codebuddy?.agentStatus, 'generating');
    assert.equal(next.ides.cursor?.agentStatus, 'idle');
  });
});
