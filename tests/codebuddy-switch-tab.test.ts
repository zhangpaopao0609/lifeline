import type { CdpClient } from '../packages/agent/src/cdp/client.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodeBuddyExecutor } from '../packages/agent/src/drivers/codebuddy/executor.js';

/**
 * CodeBuddy session rows carry data-session-tab-id (a real id), so switch must click by id
 * and then re-read the active row's id to verify — otherwise same-titled sessions click the
 * first one (same bug as on the Cursor side).
 *
 * Two expression kinds: click (includes session-tab-name / el.click) and read active id
 * (includes session-tab-active).
 */

const ACTIVE_READER = 'session-tab-active';

function fakeClient(handler: (expression: string, call: number) => unknown): {
  client: CdpClient;
  exprs: string[];
} {
  const exprs: string[] = [];
  const client = {
    isConnected: () => true,
    evaluate: async (expression: string) => {
      exprs.push(expression);
      return handler(expression, exprs.length);
    },
  } as unknown as CdpClient;
  return { client, exprs };
}

function executorWith(client: CdpClient): CodeBuddyExecutor {
  const exec = new CodeBuddyExecutor({ wait: async () => {} });
  exec.setClient(client);
  return exec;
}

describe('CodeBuddyExecutor.switchTab 按 id 点', () => {
  it('优先用 composerId 点，点完读 active 行的 id 校验', async () => {
    const reads: string[] = [];
    const { client, exprs } = fakeClient((expression) => {
      if (expression.includes(ACTIVE_READER)) {
        // First read is still the old session; the second has already switched (UI class change needs a frame)
        reads.push(expression);
        return reads.length === 1 ? 'old-session-id' : 'want-session-id';
      }
      return { ok: true };
    });
    const exec = executorWith(client);

    const result = await exec.switchTab('c1', '同名会话', undefined, { composerId: 'want-session-id' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { landedComposerId: 'want-session-id', via: 'id' });
    // The click expression must have been submitted by id (title is only used if the id misses)
    assert.match(exprs[0], /want-session-id/);
    assert.equal(exprs.filter(e => !e.includes(ACTIVE_READER)).length, 1, '只应点一次');
  });

  it('id 命中不到时才退回按标题（老行为，不丢功能）', async () => {
    let clickedByTitle = false;
    const { client, exprs } = fakeClient((expression, call) => {
      if (expression.includes(ACTIVE_READER))
        return 'want-session-id';
      if (call === 1)
        return { ok: false, error: 'Element not found' }; // click-by-id missed
      clickedByTitle = expression.includes('同名会话');
      return { ok: true };
    });
    const exec = executorWith(client);

    const result = await exec.switchTab('c2', '同名会话', undefined, { composerId: 'want-session-id' });

    assert.equal(result.ok, true);
    assert.equal((result.data as { via?: string }).via, 'title');
    assert.equal(clickedByTitle, true);
    assert.equal(exprs.length >= 2, true);
  });

  it('点了但 active 一直是别的会话 → 报失败并回带落地 id（不再假成功）', async () => {
    const { client } = fakeClient((expression) => {
      if (expression.includes(ACTIVE_READER))
        return 'someone-else-id';
      return { ok: true };
    });
    const exec = executorWith(client);

    const result = await exec.switchTab('c3', '同名会话', undefined, { composerId: 'want-session-id' });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /落到别的会话/);
    assert.equal((result.data as { landedComposerId?: string }).landedComposerId, 'someone-else-id');
  });

  it('没带 composerId 时保持老路径：只按标题点一次，不做校验', async () => {
    const { client, exprs } = fakeClient((expression) => {
      if (expression.includes(ACTIVE_READER))
        return 'whatever';
      return { ok: true };
    });
    const exec = executorWith(client);

    const result = await exec.switchTab('c4', '随便什么标题');

    assert.equal(result.ok, true);
    assert.equal(exprs.length, 1, '不带 id 时不读 active（保持老行为）');
    assert.match(exprs[0], /随便什么标题/);
  });

  it('带 id 时不走老的 selectorPath（路径会随重排过期，id 才稳）', async () => {
    const { client, exprs } = fakeClient((expression) => {
      if (expression.includes(ACTIVE_READER))
        return 'want-session-id';
      return { ok: true };
    });
    const exec = executorWith(client);

    const result = await exec.switchTab('c5', '同名会话', 'body > div:nth-of-type(3)', {
      composerId: 'want-session-id',
    });

    assert.equal(result.ok, true);
    assert.equal((result.data as { via?: string }).via, 'id');
    const clicks = exprs.filter(e => !e.includes(ACTIVE_READER));
    assert.equal(clicks.length, 1, '只点一次');
    assert.doesNotMatch(clicks[0], /querySelector\("body > div/);
  });

  it('id 点空时退到 selectorPath（老路径兜底）', async () => {
    const { client, exprs } = fakeClient((expression, call) => {
      if (expression.includes(ACTIVE_READER))
        return 'want-session-id';
      if (call === 1)
        return { ok: false, error: 'Element not found' }; // click-by-id missed
      return { ok: true }; // selectorPath hit
    });
    const exec = executorWith(client);

    const result = await exec.switchTab('c6', '同名会话', 'body > div:nth-of-type(3)', {
      composerId: 'want-session-id',
    });

    assert.equal(result.ok, true);
    assert.equal((result.data as { via?: string }).via, 'selectorPath');
    assert.match(exprs[1], /querySelector\("body > div:nth-of-type\(3\)"\)/);
  });

  it('只有 selectorPath（没有 id）时保持老路径', async () => {
    const { client, exprs } = fakeClient(() => ({ ok: true }));
    const exec = executorWith(client);

    const result = await exec.switchTab('c7', '同名会话', 'body > div:nth-of-type(3)');

    assert.equal(result.ok, true);
    assert.equal(exprs.length, 1);
    assert.match(exprs[0], /querySelector\("body > div:nth-of-type\(3\)"\)/);
  });
});
