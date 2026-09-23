import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { SelectorConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';

interface FakeState {
  clicked: string[];
  evaluated: number;
}

function fakeClient(foundInPage: boolean): { client: CdpClient; state: FakeState } {
  const state: FakeState = { clicked: [], evaluated: 0 };
  const client = {
    isConnected: () => true,
    click: async (selector: string) => {
      state.clicked.push(selector);
    },
    evaluate: async () => {
      state.evaluated += 1;
      return foundInPage;
    },
  } as unknown as CdpClient;
  return { client, state };
}

function executorWith(client: CdpClient): CommandExecutor {
  // findApproveAllButton reads the approveButton / chatContainer selectors
  const executor = new CommandExecutor({
    approveButton: {
      strategies: ['button.ui-shell-tool-call__allowlist-button'],
      textMatch: ['Accept All'],
    },
    chatContainer: { strategies: ['#root'] },
  } as unknown as SelectorConfig);
  executor.setClient(client);
  return executor;
}

describe('CommandExecutor.approveAll', () => {
  it('clicks the selectorPath the web sent (allowlist / 第二个 accept)', async () => {
    // Cursor's allowlist button copy is "Always Run 'pnpm'": searching for "Accept All" misses it,
    // so we have to click via the selector the web client sent.
    const { client, state } = fakeClient(true);
    const result = await executorWith(client).approveAll('c-path', 'span#base-ui-x > button');

    assert.equal(result.ok, true);
    assert.deepEqual(state.clicked, ['span#base-ui-x > button']);
    assert.equal(state.evaluated, 0, '带路径时不该再去页面上按文案搜按钮');
  });

  it('falls back to the in-page keyword search for clients without a selectorPath', async () => {
    const { client, state } = fakeClient(true);
    const result = await executorWith(client).approveAll('c-legacy');

    assert.equal(result.ok, true);
    // The page already clicked (the return value is a marker); do not querySelector that marker:
    // that yields "Element not found" → treated as retryable → two extra clicks.
    assert.deepEqual(state.clicked, [], 'marker 不能当选择器再点一次');
    assert.equal(state.evaluated, 1, '文案搜索只跑一次，不该重试');
  });

  it('reports failure when the page has no Accept All button', async () => {
    const { client, state } = fakeClient(false);
    const result = await executorWith(client).approveAll('c-miss');

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Accept All/);
    assert.deepEqual(state.clicked, []);
    assert.ok(state.evaluated >= 1);
  });
});
