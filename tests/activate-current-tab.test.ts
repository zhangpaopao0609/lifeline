import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { SelectorConfig } from '../packages/server/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandExecutor } from '../packages/agent/src/drivers/cursor/executor.js';

describe('CommandExecutor.activateCurrentTab', () => {
  it('clicks the session marked active in the sidebar', async () => {
    const expressions: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        expressions.push(expression);
        if (expression.includes('__listCursorSessionTabs')) {
          return [
            { title: 'Older chat', isActive: false },
            { title: 'Current chat', isActive: true },
          ];
        }
        return { clicked: true, occluded: false };
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.activateCurrentTab('a1');
    assert.equal(result.ok, true);
    assert.equal((result.data as { title?: string }).title, 'Current chat');
    assert.equal(expressions.some(e => e.includes('Current chat')), true);
  });

  it('does not click when several sessions are idle', async () => {
    let clicks = 0;
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        if (expression.includes('__listCursorSessionTabs')) {
          return [
            { title: 'A', isActive: false },
            { title: 'B', isActive: false },
          ];
        }
        clicks += 1;
        return { clicked: true, occluded: false };
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.activateCurrentTab('a2');
    assert.equal(result.ok, true);
    assert.equal((result.data as { activated?: boolean }).activated, false);
    assert.equal(clicks, 0);
  });
});
