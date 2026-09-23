import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCdpUnreachable, nextReconnectDelay } from '../packages/agent/src/cdp/relaunch-engine.js';

describe('nextReconnectDelay by kind', () => {
  it('keeps no-listener at 500ms', () => {
    assert.equal(nextReconnectDelay(1000, { kind: 'no-listener', max: 30_000 }), 500);
    assert.equal(nextReconnectDelay(16_000, { kind: 'no-listener', max: 30_000 }), 500);
  });
  it('goes quiet (30s) for no-listener on a machine with no GUI IDE', () => {
    assert.equal(
      nextReconnectDelay(1000, { kind: 'no-listener', max: 30_000, quietNoListener: true }),
      30_000,
    );
    assert.equal(
      nextReconnectDelay(16_000, { kind: 'no-listener', max: 30_000, quietNoListener: true }),
      30_000,
    );
  });
  it('holds no-window at 2000ms', () => {
    assert.equal(nextReconnectDelay(1000, { kind: 'no-window', max: 30_000 }), 2000);
    assert.equal(nextReconnectDelay(8000, { kind: 'no-window', max: 30_000 }), 2000);
  });
  it('starts not-cdp at 5000 and caps at 30000', () => {
    assert.equal(nextReconnectDelay(0, { kind: 'not-cdp', max: 30_000 }), 5000);
    assert.equal(nextReconnectDelay(5000, { kind: 'not-cdp', max: 30_000 }), 10_000);
    assert.equal(nextReconnectDelay(20_000, { kind: 'not-cdp', max: 30_000 }), 30_000);
  });
  it('caps no-workbench / attach-failed / unknown at 10000', () => {
    assert.equal(nextReconnectDelay(0, { kind: 'no-workbench', max: 30_000 }), 1000);
    assert.equal(nextReconnectDelay(8000, { kind: 'attach-failed', max: 30_000 }), 10_000);
    assert.equal(nextReconnectDelay(10_000, { kind: 'unknown', max: 30_000 }), 10_000);
  });
});

describe('isCdpUnreachable regression', () => {
  it('still ignores abort', () => {
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    assert.equal(isCdpUnreachable(aborted), false);
  });
});
