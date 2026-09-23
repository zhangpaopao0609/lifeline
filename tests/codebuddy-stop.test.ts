import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CODEBUDDY_STOP_JS, CodeBuddyExecutor } from '../packages/agent/src/drivers/codebuddy/executor.js';

/**
 * The stop button is the composer bottom-right submit button in another identity. The DOM has
 * no stop class and no aria-label (2026-09-18 live probe); the only handle is React fiber
 * `loading / onSend / onCancel`. These cases pin that: call onCancel only when loading is true;
 * every other case reports the error as-is.
 */
function clientReturning(value: unknown, seen: string[] = []): CdpClient {
  return {
    isConnected: () => true,
    evaluate: async (expression: string) => {
      seen.push(expression);
      return value;
    },
  } as unknown as CdpClient;
}

describe('CodeBuddyExecutor.stop', () => {
  it('走 fiber onCancel，且带 loading 判据（不猜图标 / 不猜类名）', async () => {
    const seen: string[] = [];
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(clientReturning({ ok: true, via: 'fiber.onCancel' }, seen));

    const result = await exec.stop('s1');

    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /__reactFiber\$/);
    assert.match(seen[0], /props\.onCancel\(\)/);
    assert.match(seen[0], /props\.loading === true/);
    assert.match(seen[0], /chat-input-module_container/);
  });

  it('没在生成：把 Not generating 原样带回，不当成功', async () => {
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(clientReturning({ ok: false, error: 'Not generating' }));

    const result = await exec.stop('s2');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Not generating');
  });

  it('找不到提交按钮：Stop button not found', async () => {
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(clientReturning({ ok: false, error: 'Stop button not found' }));

    const result = await exec.stop('s3');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Stop button not found');
  });

  it('onCancel 抛错：报出来，不回假成功', async () => {
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(clientReturning({ ok: false, error: 'onCancel threw: boom' }));

    const result = await exec.stop('s4');

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /onCancel threw/);
  });

  it('未连接：Not connected to CodeBuddy', async () => {
    const exec = new CodeBuddyExecutor({ wait: async () => {} });

    const result = await exec.stop('s5');

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Not connected/);
  });

  it('表达式进 iframe 取 composer 容器（和发送同源）', () => {
    assert.match(CODEBUDDY_STOP_JS, /active-frame/);
    assert.match(CODEBUDDY_STOP_JS, /scope\.querySelectorAll\('\[role="button"\], button'\)/);
  });
});
