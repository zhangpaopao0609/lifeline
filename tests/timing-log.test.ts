import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { timingLastBubble, timingLog, timingPreview } from '../packages/agent/src/timing-log.js';

describe('timingLog', () => {
  it('collapses previews and skips empty fields', () => {
    assert.equal(timingPreview('你是？\n下一行'), '你是？ 下一行');
    assert.equal(timingPreview('abcdefghijklmnop', 4), 'abcd');
    assert.equal(timingPreview(undefined), '');
    assert.equal(timingLastBubble([
      { type: 'human', text: '你是？' },
      { type: 'tool' },
      { type: 'assistant', text: '我是助手' },
    ]), 'assistant:我是助手');

    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      timingLog('router:in', { commandId: 'abc', ide: 'codebuddy', chars: 3, skip: undefined });
    }
    finally {
      console.log = orig;
    }
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '[timing] router:in commandId=abc ide=codebuddy chars=3');
  });
});
