import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickWindowSession } from '../packages/agent/src/window-session.js';

describe('pickWindowSession', () => {
  it('prefers the tab marked active', () => {
    assert.equal(
      pickWindowSession([
        { title: 'Older chat', isActive: false },
        { title: 'Current chat', isActive: true },
      ]),
      'Current chat',
    );
  });

  it('uses the only session when none is marked active', () => {
    assert.equal(
      pickWindowSession([{ title: 'Solo', isActive: false }]),
      'Solo',
    );
  });

  it('does not guess when several sessions are idle', () => {
    assert.equal(
      pickWindowSession([
        { title: 'A', isActive: false },
        { title: 'B', isActive: false },
      ]),
      undefined,
    );
  });
});
