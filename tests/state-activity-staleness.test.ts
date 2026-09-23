import type { CursorState, RawSignals } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_ACTIVITY_STALE_MS } from '../packages/agent/src/activity-stale.js';
import { StateManager } from '../packages/agent/src/state-manager.js';
import { emptyCursorState } from '../packages/server/src/pages/empty-state.js';

/**
 * Long tasks (npm install / large-file edits) leave copy unchanged for minutes while the
 * transcript loading signal stays on. That "it is clearly running" state must not be extinguished
 * by copy-staleness — extinguishing drops the web session-row loading spinner and title status
 * together (2026-09-15 feedback: switch to a running session and the spinner is gone).
 */

const NO_SIGNALS: RawSignals = { shimmer: [], loadingIndicator: false, elements: [], orphanIndicators: [] };

const LOADING_SIGNALS: RawSignals = {
  shimmer: [],
  loadingIndicator: true,
  elements: [],
  orphanIndicators: [],
};

function extracting(text: string, raw: RawSignals, overrides: Partial<CursorState> = {}): CursorState {
  return {
    ...emptyCursorState(),
    connected: true,
    extractorStatus: 'ok',
    agentStatus: 'running_tool',
    agentActivityText: text,
    agentActivityLive: true,
    agentActivitySource: 'loading_tool',
    ...overrides,
    _rawSignals: raw,
  };
}

/** Under a fake clock, feed the same extract at each atMs in order (simulates the poll cycle) */
function pollAt(sm: StateManager, state: CursorState, atMs: number[]): void {
  const realNow = Date.now;
  const t0 = realNow();
  try {
    for (const ms of atMs) {
      Date.now = () => t0 + ms;
      sm.onExtraction({ ...state, _rawSignals: { ...state._rawSignals! } });
    }
  }
  finally {
    Date.now = realNow;
  }
}

/** Drop a baseline, then extract once after quietMs of silence (spot-check status "after this long quiet") */
function settleThenQuiet(sm: StateManager, state: CursorState, quietMs: number): void {
  pollAt(sm, state, [0, 1_000, quietMs]);
}

describe('StateManager activity staleness', () => {
  it('keeps a running session live while DOM work signals are present', () => {
    const sm = new StateManager(1);
    const state = extracting('Running install.sh', LOADING_SIGNALS);

    settleThenQuiet(sm, state, AGENT_ACTIVITY_STALE_MS * 2);

    const cur = sm.getCurrentState();
    assert.equal(cur.agentActivityText, 'Running install.sh');
    assert.equal(cur.agentActivityLive, true);
    assert.equal(cur.agentStatus, 'running_tool');
  });

  it('still clears a stale label once the work signals are gone', () => {
    const sm = new StateManager(1);
    const idleAfterWork = extracting('Running install.sh', NO_SIGNALS, {
      agentStatus: 'idle',
      agentActivityLive: false,
      agentActivitySource: 'none',
    });

    settleThenQuiet(sm, idleAfterWork, AGENT_ACTIVITY_STALE_MS + 10_000);

    const cur = sm.getCurrentState();
    assert.equal(cur.agentActivityText, null);
    assert.equal(cur.agentActivityLive, false);
    assert.equal(cur.agentStatus, 'idle');
  });

  it('comes back live when work signals return after a stale clear', () => {
    const sm = new StateManager(1);
    const idleAfterWork = extracting('Running install.sh', NO_SIGNALS, {
      agentStatus: 'idle',
      agentActivityLive: false,
      agentActivitySource: 'none',
    });
    settleThenQuiet(sm, idleAfterWork, AGENT_ACTIVITY_STALE_MS + 10_000);
    assert.equal(sm.getCurrentState().agentActivityText, null);

    sm.onExtraction(extracting('Running install.sh', LOADING_SIGNALS));

    const cur = sm.getCurrentState();
    assert.equal(cur.agentActivityText, 'Running install.sh');
    assert.equal(cur.agentActivityLive, true);
    assert.equal(cur.agentStatus, 'running_tool');
  });

  it('keeps waiting_approval untouched regardless of signals', () => {
    const sm = new StateManager(1);
    const waiting = extracting('Waiting for approval', NO_SIGNALS, {
      agentStatus: 'waiting_approval',
      agentActivityLive: false,
      agentActivitySource: 'none',
    });

    settleThenQuiet(sm, waiting, AGENT_ACTIVITY_STALE_MS * 2);

    const cur = sm.getCurrentState();
    assert.equal(cur.agentStatus, 'waiting_approval');
    assert.equal(cur.agentActivityText, null);
    assert.equal(cur.agentActivityLive, false);
  });
});
