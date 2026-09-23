import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodeBuddyExecutor } from '../packages/agent/src/drivers/codebuddy/executor.js';

/**
 * CodeBuddy CN 2026-09 moved the "+" new-chat control out of the coding-copilot
 * webview into the workbench action bar. newChat must click the workbench
 * button first, and fall back to the old webview cascade for older builds.
 */
describe('CodeBuddyExecutor.newChat', () => {
  it('clicks the workbench action-bar button when the workbench client is set', async () => {
    const workbenchExprs: string[] = [];
    const webviewExprs: string[] = [];
    const workbench = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        workbenchExprs.push(expression);
        return { ok: true };
      },
    } as unknown as CdpClient;
    const webview = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        webviewExprs.push(expression);
        return { ok: false, error: 'New Chat button not found' };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(webview);
    exec.setWorkbenchClient(workbench);

    const result = await exec.newChat('n1');
    assert.equal(result.ok, true);
    assert.equal(workbenchExprs.length, 1);
    assert.match(workbenchExprs[0], /codicon-codingcopilot-new-chat/);
    assert.match(workbenchExprs[0], /Start New Chat/);
    assert.equal(webviewExprs.length, 0, 'webview cascade must not run when workbench click succeeds');
  });

  it('falls back to the webview cascade when the workbench button is missing', async () => {
    const webviewExprs: string[] = [];
    const workbench = {
      isConnected: () => true,
      evaluate: async () => ({ ok: false, error: 'New Chat button not found' }),
    } as unknown as CdpClient;
    const webview = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        webviewExprs.push(expression);
        return { ok: true };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(webview);
    exec.setWorkbenchClient(workbench);

    const result = await exec.newChat('n2');
    assert.equal(result.ok, true);
    assert.equal(webviewExprs.length, 1);
    assert.match(webviewExprs[0], /session-tab-add/);
  });

  it('falls back when the workbench evaluate throws', async () => {
    const workbench = {
      isConnected: () => true,
      evaluate: async () => {
        throw new Error('WebSocket closed');
      },
    } as unknown as CdpClient;
    const webview = {
      isConnected: () => true,
      evaluate: async () => ({ ok: true }),
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(webview);
    exec.setWorkbenchClient(workbench);

    const result = await exec.newChat('n3');
    assert.equal(result.ok, true);
  });

  it('keeps the legacy webview-only path when no workbench client is set', async () => {
    const webviewExprs: string[] = [];
    const webview = {
      isConnected: () => true,
      evaluate: async (expression: string) => {
        webviewExprs.push(expression);
        return { ok: false, error: 'New Chat button not found' };
      },
    } as unknown as CdpClient;
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    exec.setClient(webview);

    const result = await exec.newChat('n4');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'New Chat button not found');
    assert.equal(webviewExprs.length, 1);
  });

  it('reports not connected when both clients are missing', async () => {
    const exec = new CodeBuddyExecutor({ wait: async () => {} });
    const result = await exec.newChat('n5');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Not connected/);
  });
});
