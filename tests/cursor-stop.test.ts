import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import type { SelectorConfig } from '../packages/agent/src/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandExecutor, CURSOR_STOP_JS } from '../packages/agent/src/drivers/cursor/executor.js';

/**
 * Cursor's stop control changes shape per window (2026-09-18 two-window probe):
 *  - Project window: composer is not React, DOM only — the generating button has `data-stop-button="true"`;
 *  - Agents window: React; while generating the submit-button aria-label becomes `Stop generation`.
 * These cases pin "only treat the generating state; do not click the idle one".
 */
function selectors(): SelectorConfig {
  return {
    chatContainer: { strategies: [] },
    approveButton: { strategies: [] },
    rejectButton: { strategies: [] },
    chatInput: { strategies: [] },
    agentStatus: { strategies: [] },
  };
}

function clientReturning(value: unknown, seen: string[] = []): CdpClient {
  return {
    isConnected: () => true,
    evaluate: async (expression: string) => {
      seen.push(expression);
      return value;
    },
  } as unknown as CdpClient;
}

describe('CommandExecutor.stop', () => {
  it('表达式认两套窗口的停止态，且不碰空闲态那颗', () => {
    assert.match(CURSOR_STOP_JS, /\[class\*="send-with-mode"\] \[data-stop-button="true"\]/);
    assert.match(CURSOR_STOP_JS, /button\.ui-prompt-input-submit-button/);
    assert.match(CURSOR_STOP_JS, /\^\(stop\|停止\)/);
    // Miss → report Not generating — do not fall back to clicking the "looks like submit" button (that opens voice / sends a draft)
    assert.match(CURSOR_STOP_JS, /'Not generating'/);
  });

  it('项目窗口命中：点掉停止键并回 ok', async () => {
    const seen: string[] = [];
    const exec = new CommandExecutor(selectors());
    exec.setClient(clientReturning({ ok: true, via: 'project:data-stop-button' }, seen));

    const result = await exec.stop('c1');

    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /data-stop-button/);
  });

  it('Agents 窗口命中：aria-label 是 Stop generation', async () => {
    const exec = new CommandExecutor(selectors());
    exec.setClient(clientReturning({ ok: true, via: 'agents:aria-label' }));

    const result = await exec.stop('c2');

    assert.equal(result.ok, true);
  });

  it('没在生成：Not generating 原样带回，不当成功', async () => {
    const exec = new CommandExecutor(selectors());
    exec.setClient(clientReturning({ ok: false, error: 'Not generating' }));

    const result = await exec.stop('c3');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Not generating');
  });

  it('找不到提交键：Stop button not found', async () => {
    const exec = new CommandExecutor(selectors());
    exec.setClient(clientReturning({ ok: false, error: 'Stop button not found' }));

    const result = await exec.stop('c4');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Stop button not found');
  });

  it('未连接：Not connected to Cursor', async () => {
    const exec = new CommandExecutor(selectors());

    const result = await exec.stop('c5');

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Not connected/);
  });
});
