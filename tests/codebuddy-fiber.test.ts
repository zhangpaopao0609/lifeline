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
  it('fails when the composer still contains the sent text after onEnter', async () => {
    const client = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        if (expression.includes('insertText'))
          return { ok: true };
        if (expression.includes('onEnter'))
          return { called: true };
        return { dom: 'keep $& me', model: 'keep $& me' };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(client);
    const result = await exec.sendMessage('c1', 'keep $& me');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'onEnter returned early');
  });
});
