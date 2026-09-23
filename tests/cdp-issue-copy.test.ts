import type { CdpIssue } from '../packages/web/src/net/protocol.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cdpIssueCopy } from '../packages/web/src/lib/cdp-issue-copy.ts';

function issue(overrides: Partial<CdpIssue> = {}): CdpIssue {
  return {
    kind: 'unknown',
    scope: 'workbench',
    cdpUrl: 'http://127.0.0.1:9222',
    port: 9222,
    detail: '',
    at: 1,
    ...overrides,
  };
}

describe('cdpIssueCopy', () => {
  it('says the IDE is not running when relaunch skipped because it is not running', () => {
    const copy = cdpIssueCopy(issue({ kind: 'no-listener', relaunch: 'skipped-not-running' }), 'Cursor');
    assert.equal(copy.tone, 'info');
    assert.equal(copy.text, 'Cursor 没在运行，打开它即可');
  });

  // When the agent cannot find the executable it neither retries nor pulls — the user must see why, not just "can't connect"
  it('explains that the executable could not be located', () => {
    const copy = cdpIssueCopy(issue({ kind: 'no-listener', relaunch: 'skipped-no-exe' }), 'Cursor');
    assert.equal(copy.tone, 'warn');
    assert.match(copy.text, /找不到 Cursor 的程序位置/);
    assert.match(copy.text, /App Paths/);
  });

  it('says auto-restart is in progress after relaunched or while warming up', () => {
    const relaunched = cdpIssueCopy(issue({ kind: 'no-listener', relaunch: 'relaunched' }), 'Cursor');
    const warming = cdpIssueCopy(issue({ kind: 'no-listener', relaunch: 'skipped-warming-up' }), 'Cursor');
    assert.equal(relaunched.tone, 'progress');
    assert.equal(warming.tone, 'progress');
    assert.equal(relaunched.text, 'Cursor 没有带调试参数启动，正在尝试自动重启它…');
    assert.equal(warming.text, relaunched.text);
  });

  it('falls back to a generic no-listener sentence for cooldown, quit-pending, and platform skip', () => {
    for (const relaunch of ['skipped-cooldown', 'skipped-quit-pending', 'skipped-platform'] as const) {
      const copy = cdpIssueCopy(issue({ kind: 'no-listener', relaunch }), 'Cursor');
      assert.equal(copy.tone, 'info');
      assert.equal(copy.text, '连不上 Cursor 的调试端口');
    }
    const bare = cdpIssueCopy(issue({ kind: 'no-listener' }), 'CodeBuddy');
    assert.equal(bare.text, '连不上 CodeBuddy 的调试端口');
  });

  it('keeps http occupancy copy distinct from a foreign CDP', () => {
    const http = cdpIssueCopy(issue({
      kind: 'not-cdp',
      notCdpCause: 'http',
      occupant: 'Google Chrome (pid 65600)',
    }), 'Cursor');
    const foreign = cdpIssueCopy(issue({
      kind: 'not-cdp',
      notCdpCause: 'foreign',
      browser: 'Chrome/148.0.7778.280',
    }), 'Cursor');
    assert.equal(http.tone, 'warn');
    assert.equal(foreign.tone, 'warn');
    assert.equal(http.text, '9222 被 Google Chrome (pid 65600) 占着，lifeline 连不上 Cursor。关掉它，或换一个端口');
    assert.equal(foreign.text, '端口 9222 上是 Chrome/148.0.7778.280，不是 Cursor');
    assert.notEqual(http.text, foreign.text);
  });

  it('still explains an http occupancy without occupant', () => {
    const copy = cdpIssueCopy(issue({ kind: 'not-cdp', notCdpCause: 'http' }), 'Cursor');
    assert.equal(copy.tone, 'warn');
    assert.match(copy.text, /9222/);
    assert.match(copy.text, /占着/);
    assert.match(copy.text, /Cursor/);
    assert.doesNotMatch(copy.text, /undefined/);
  });

  it('still explains a foreign CDP without a Browser string', () => {
    const copy = cdpIssueCopy(issue({ kind: 'not-cdp', notCdpCause: 'foreign' }), 'Cursor');
    assert.equal(copy.tone, 'warn');
    assert.match(copy.text, /端口 9222/);
    assert.match(copy.text, /不是 Cursor/);
    assert.doesNotMatch(copy.text, /undefined/);
    assert.doesNotMatch(copy.text, /还没打开窗口/);
  });

  it('waits for a window instead of alarming', () => {
    const copy = cdpIssueCopy(issue({ kind: 'no-window' }), 'Cursor');
    assert.equal(copy.tone, 'wait');
    assert.equal(copy.text, 'Cursor 还没打开窗口');
  });

  it('swaps the product name for CodeBuddy', () => {
    assert.equal(
      cdpIssueCopy(issue({ kind: 'no-window' }), 'CodeBuddy').text,
      'CodeBuddy 还没打开窗口',
    );
    assert.equal(
      cdpIssueCopy(issue({ kind: 'no-workbench' }), 'CodeBuddy').text,
      '端口 9222 上没找到可接入的 CodeBuddy 窗口',
    );
  });

  it('names a missing workbench on the port', () => {
    const copy = cdpIssueCopy(issue({ kind: 'no-workbench', port: 9223 }), 'Cursor');
    assert.equal(copy.tone, 'info');
    assert.equal(copy.text, '端口 9223 上没找到可接入的 Cursor 窗口');
  });

  it('uses detail for attach-failed and unknown', () => {
    assert.equal(
      cdpIssueCopy(issue({ kind: 'attach-failed', detail: 'ws handshake refused' }), 'Cursor').text,
      'ws handshake refused',
    );
    assert.equal(
      cdpIssueCopy(issue({ kind: 'unknown', detail: 'fetch aborted after 5s' }), 'Cursor').text,
      'fetch aborted after 5s',
    );
    assert.equal(cdpIssueCopy(issue({ kind: 'attach-failed', detail: 'ws handshake refused' }), 'Cursor').tone, 'info');
    assert.equal(cdpIssueCopy(issue({ kind: 'unknown', detail: 'fetch aborted after 5s' }), 'Cursor').tone, 'info');
  });

  it('does not call a missing-UA unknown a closed window', () => {
    const copy = cdpIssueCopy(issue({ kind: 'unknown', detail: 'User-Agent missing' }), 'Cursor');
    assert.equal(copy.tone, 'info');
    assert.equal(copy.text, 'User-Agent missing');
    assert.doesNotMatch(copy.text, /没打开窗口|还没打开窗口|没找到可接入/);
  });
});
