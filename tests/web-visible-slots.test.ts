import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEGACY_SLOTS, visibleSlots } from '../packages/web/src/lib/visible-slots.js';

/**
 * The rail must render exactly the slots a machine reported.
 *
 * Pre-split this was `IDE_KINDS.map(...)` — harmless while every machine had both
 * slots, but with a conditional `vscode` slot it put a "VS Code" row on every
 * plugin-less machine. That row is clickable, and the command it sends is folded
 * into the cursor slot by an un-upgraded agent.
 */
describe('visibleSlots', () => {
  it('renders only reported slots, in canonical order', () => {
    assert.deepEqual(visibleSlots(['cursor', 'codebuddy']), ['cursor', 'codebuddy']);
    assert.deepEqual(visibleSlots(['cursor', 'codebuddy', 'vscode']), ['cursor', 'codebuddy', 'vscode']);
    // Order comes from IDE_KINDS, not from insertion order.
    assert.deepEqual(visibleSlots(['vscode', 'cursor']), ['cursor', 'vscode']);
  });

  it('drops keys this build does not know', () => {
    assert.deepEqual(visibleSlots(['cursor', 'nope']), ['cursor']);
  });

  it('falls back to the pre-split set when there is no summary at all', () => {
    // Old server / offline machine with no `ides` summary: two honest rows.
    assert.deepEqual(visibleSlots(undefined), [...LEGACY_SLOTS]);
    assert.deepEqual(visibleSlots([]), [...LEGACY_SLOTS]);
  });

  it('can be told to render nothing when a caller has a better answer', () => {
    assert.deepEqual(visibleSlots([], []), []);
  });
});
