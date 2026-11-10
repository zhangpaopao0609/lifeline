import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodeBuddyExecutor } from '../packages/agent/src/drivers/codebuddy/executor.js';
import {
  FIBER_ENTER_JS,
  FIBER_INSERT_JS,
  fiberInsertExpression,
  interpretFiberSendResult,
} from '../packages/agent/src/drivers/codebuddy/fiber-script.js';

describe('CodeBuddy fiber scripts', () => {
  it('inserts via Slate insertText and submits via onEnter', () => {
    assert.match(FIBER_INSERT_JS, /insertText/);
    assert.match(FIBER_ENTER_JS, /onEnter/);
    assert.doesNotMatch(FIBER_INSERT_JS, /children\s*=/);
    assert.doesNotMatch(FIBER_INSERT_JS, /Input\.insertText/);
  });

  it('keeps $& literal when injecting message text', () => {
    const js = fiberInsertExpression('hello $& world');
    assert.ok(js.includes(JSON.stringify('hello $& world')));
    assert.equal(js.includes('hello __FIBER_TEXT__ world'), false);
  });
});

describe('interpretFiberSendResult', () => {
  it('does not treat a invoked onEnter as delivered when composer still has the text', () => {
    const result = interpretFiberSendResult({
      inserted: { ok: true },
      entered: { called: true },
      stillContains: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'onEnter returned early');
  });

  it('succeeds only when the composer no longer contains the sent text', () => {
    const result = interpretFiberSendResult({
      inserted: { ok: true },
      entered: { called: true },
      stillContains: false,
    });
    assert.equal(result.ok, true);
  });
});

describe('CodeBuddyExecutor.sendMessage', () => {
  // Policy: Enter ran, so the message may well have gone out. A "failed" verdict here is what produced
  // the duplicate-send prompt (2026-11-09); an unverified success only leaves a bubble that reconciles
  // when the disk projection catches up.
  it('reports an unverified success when the composer never clears after onEnter', async () => {
    let reads = 0;
    const client = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        if (expression.includes('insertText'))
          return { ok: true };
        if (expression.includes('onEnter'))
          return { called: true };
        reads += 1;
        return { dom: 'keep $& me', model: 'keep $& me' };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(client);
    const result = await exec.sendMessage('c1', 'keep $& me');
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { unverified: true, reason: 'composer-still-contains' });
    assert.ok(reads >= 2, 'the budget is spent watching the composer, not a single read');
  });

  it('does not wait the budget when onEnter reports it did not run', async () => {
    let reads = 0;
    const client = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        if (expression.includes('insertText'))
          return { ok: true };
        if (expression.includes('onEnter'))
          return { called: false, error: 'enter disabled' };
        reads += 1;
        return { dom: 'still here', model: 'still here' };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(client);
    const result = await exec.sendMessage('c3', 'still here');
    assert.equal(result.ok, false);
    assert.equal(reads, 1, 'one read is enough when Enter never ran');
  });

  // Measured 2026-11-09 (vscode slot): the turn reached the disk, but the snapshot taken right after
  // onEnter still showed the text — the executor reported a failure the page turned into a 重试 prompt,
  // and retrying would have sent the message twice. The plugin clears the editor on its own schedule.
  it('succeeds when the composer clears a beat after onEnter', async () => {
    let reads = 0;
    const client = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        if (expression.includes('insertText'))
          return { ok: true };
        if (expression.includes('onEnter'))
          return { called: true };
        reads += 1;
        return reads < 3
          ? { dom: 'async clear', model: 'async clear' }
          : { dom: '', model: '[]' };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(client);
    const result = await exec.sendMessage('c2', 'async clear');
    assert.equal(result.ok, true);
    assert.ok(reads >= 3, 'must keep watching the composer instead of judging on the first read');
  });
});
