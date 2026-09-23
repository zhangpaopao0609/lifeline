import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { SelectorConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getDefaultSelectors } from '../packages/agent/src/config.js';
import { CommandExecutor, isUnsafeChatInputInfo } from '../packages/agent/src/drivers/cursor/executor.js';

describe('isUnsafeChatInputInfo', () => {
  it('rejects the xterm helper that stole a phone send', () => {
    assert.equal(
      isUnsafeChatInputInfo('TEXTAREA.xterm-helper-textarea | sel=textarea'),
      true,
    );
  });

  it('accepts the Cursor agent composer', () => {
    assert.equal(
      isUnsafeChatInputInfo('DIV.aislash-editor-input | sel=[contenteditable=\'true\']'),
      false,
    );
  });
});

describe('getDefaultSelectors chatInput', () => {
  it('does not fall through to a bare textarea (matches the terminal)', () => {
    const strategies = getDefaultSelectors().chatInput.strategies;
    assert.equal(strategies.includes('textarea'), false);
    assert.ok(strategies.some(sel => sel.includes('aislash-editor-input')));
  });
});

describe('CommandExecutor.sendMessage', () => {
  it('does not type into the terminal when focus lands on xterm', async () => {
    const typed: string[] = [];
    const keys: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async () => ({
        ok: true,
        info: 'TEXTAREA.xterm-helper-textarea | sel=textarea',
      }),
      typeText: async (text: string) => {
        typed.push(text);
      },
      pressKey: async (key: string) => {
        keys.push(key);
      },
    } as unknown as CdpClient;

    const executor = new CommandExecutor({
      chatInput: { strategies: ['textarea'] },
    } as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.sendMessage('cmd-xterm', '你是什么');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /composer|terminal/i);
    assert.deepEqual(typed, []);
    assert.deepEqual(keys, []);
  });
});
