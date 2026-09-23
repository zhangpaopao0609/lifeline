import type { CdpIssue, CursorState } from '../packages/protocol/src/wire.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StateManager } from '../packages/agent/src/state-manager.js';
import { emptyCursorState } from '../packages/protocol/src/empty.js';

function sampleIssue(overrides: Partial<CdpIssue> = {}): CdpIssue {
  return {
    kind: 'not-cdp',
    scope: 'workbench',
    cdpUrl: 'http://127.0.0.1:9222',
    port: 9222,
    detail: 'occupied',
    at: 1,
    ...overrides,
  };
}

describe('StateManager CDP issues', () => {
  it('does not emit when only at changes', () => {
    const sm = new StateManager(60_000);
    const patches: Array<Partial<CursorState>> = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    const base = sampleIssue({ notCdpCause: 'http' });
    sm.setCdpIssue(base);
    assert.equal(patches.length, 1);

    sm.setCdpIssue({ ...base, at: 99_999 });
    assert.equal(patches.length, 1);
  });

  it('emits when notCdpCause changes', () => {
    const sm = new StateManager(60_000);
    const patches: Array<Partial<CursorState>> = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    sm.setCdpIssue(sampleIssue({ notCdpCause: 'http' }));
    sm.setCdpIssue(sampleIssue({ notCdpCause: 'foreign' }));
    assert.equal(patches.length, 2);
    assert.equal(patches[1]?.cdpIssue?.notCdpCause, 'foreign');
  });

  it('onExtraction keeps liveIssue', () => {
    const sm = new StateManager(60_000);
    const live = sampleIssue({ scope: 'live', kind: 'attach-failed', detail: 'ws fail' });
    sm.setLiveIssue(live);

    sm.onExtraction(emptyCursorState());
    assert.deepEqual(sm.getCurrentState().liveIssue, live);
  });

  it('diff can clear cdpIssue to null', () => {
    const sm = new StateManager(60_000);
    const patches: Array<Partial<CursorState>> = [];
    sm.on('state:patch', (patch: Partial<CursorState>) => patches.push(patch));

    sm.setCdpIssue(sampleIssue());
    sm.setCdpIssue(null);
    assert.equal(patches.length, 2);
    assert.equal(patches[1]?.cdpIssue, null);
    assert.equal(sm.getCurrentState().cdpIssue, null);
  });
});
