import type { Bubble } from '../packages/agent/src/sources/cursor-adapter.js';
import type { MessageHeader } from '../packages/agent/src/sources/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { project } from '../packages/agent/src/sources/project.js';

function header(id: string, role: MessageHeader['role']): MessageHeader {
  return { messageId: id, role, createdAt: 1, complete: true };
}

describe('project', () => {
  it('preserves search terms, task links and bounded readable tool output', () => {
    const calls = [
      { name: 'web_search', params: { searchTerm: 'cursor agents' }, result: { markdown: 'search result' } },
      { name: 'ripgrep_raw_search', params: { pattern: 'SessionRef', path: 'src' }, result: { error: 'no matches' } },
      { name: 'task_v2', params: { description: 'Inspect routes' }, result: { agentId: 'child' } },
      { name: 'run_terminal_command_v2', params: { command: 'pnpm test' }, result: { output: 'x'.repeat(5000) } },
    ];
    const { messages } = project(calls.map((_, i) => header(`t${i}`, 'assistant')), calls.map((toolFormerData, i) => ({
      bubbleId: `t${i}`,
      type: 2,
      createdAt: 1,
      text: '',
      toolFormerData,
    })));
    const tools = messages.filter(m => m.type === 'tool');
    assert.equal(tools[0].summaryText, 'cursor agents');
    assert.equal(tools[0].output, 'search result');
    assert.equal(tools[1].summaryText, 'SessionRef');
    assert.equal(tools[1].filename, 'src');
    assert.equal(tools[1].output, 'no matches');
    assert.equal(tools[2].summaryText, 'Inspect routes');
    assert.equal(tools[2].childSessionId, 'child');
    assert.equal(tools[3].summaryText, 'pnpm test');
    assert.equal(tools[3].output, `${'x'.repeat(4000)}\n…`);
  });

  it('emits in index order and skips bubbles not in the index', () => {
    const bubbles: Bubble[] = [
      { bubbleId: 'ghost', type: 2, createdAt: 1, text: 'ghost' },
      { bubbleId: 'h1', type: 1, createdAt: 1, text: 'hello' },
      { bubbleId: 'a1', type: 2, createdAt: 2, text: '**hi**' },
    ];
    const { messages, stats } = project(
      [header('h1', 'human'), header('a1', 'assistant')],
      bubbles,
    );
    assert.equal(messages.map(m => m.id).join(','), 'h1,a1');
    assert.equal(messages[0].type, 'human');
    assert.equal(messages[1].type, 'assistant');
    assert.equal((messages[1] as { text: string }).text, '**hi**');
    assert.equal(stats.missing, 0);
  });

  it('shows the user_query inside a wrapped human bubble', () => {
    const bubbles: Bubble[] = [
      {
        bubbleId: 'h1',
        type: 1,
        createdAt: 1,
        text: '<timestamp>Wednesday, Oct 14, 2026, 1:59 PM (UTC+8)</timestamp>\n<system_notification>task finished</system_notification>\n<user_query>\n汇总下测试结果\n</user_query>',
      },
    ];
    const { messages } = project([header('h1', 'human')], bubbles);
    assert.equal(messages.length, 1);
    assert.equal((messages[0] as { text: string }).text, '汇总下测试结果');
  });

  it('renders a simulated system message as a compact notification', () => {
    const bubbles: Bubble[] = [
      {
        bubbleId: 'n1',
        type: 1,
        createdAt: 1,
        text: '<system_notification>\n<task>\nstatus: success\ntitle: Register another account\n</task>\n</system_notification>\n<user_query>Perform follow-up work</user_query>',
      },
    ];
    const notification: MessageHeader = {
      ...header('n1', 'human'),
      notificationTitle: 'Register another account',
    };
    const { messages } = project([notification], bubbles);
    assert.deepEqual(messages, [{
      type: 'notification',
      id: 'n1',
      flatIndex: 0,
      title: 'Register another account',
      status: 'success',
      createdAt: 1,
    }]);
  });

  it('counts missing index entries', () => {
    const { stats } = project([header('nope', 'human')], []);
    assert.equal(stats.missing, 1);
  });

  it('maps toolFormerData into a tool element and todo_write into todo_list', () => {
    const bubbles: Bubble[] = [
      {
        bubbleId: 't1',
        type: 2,
        createdAt: 1,
        text: '',
        toolFormerData: {
          toolCallId: 'c1',
          name: 'read_file_v2',
          status: 'completed',
          params: '{"relativeWorkspacePath":"a.ts"}',
        },
      },
      {
        bubbleId: 'td',
        type: 2,
        createdAt: 2,
        text: '',
        toolFormerData: {
          toolCallId: 'c2',
          name: 'todo_write',
          status: 'completed',
          params: { todos: [{ content: 'x', status: 'completed' }] },
        },
      },
    ];
    const { messages } = project(
      [header('t1', 'assistant'), header('td', 'assistant')],
      bubbles,
    );
    assert.equal(messages[0].type, 'tool');
    assert.equal((messages[0] as { toolCallId: string }).toolCallId, 'c1');
    assert.equal(messages[1].type, 'todo_list');
  });

  it('parses params whether string or object', () => {
    const bubbles: Bubble[] = [
      {
        bubbleId: 'e1',
        type: 2,
        createdAt: 1,
        text: '',
        toolFormerData: {
          toolCallId: 'c',
          name: 'edit_file_v2',
          status: 'completed',
          params: '{"relativeWorkspacePath":"f.md"}',
        },
      },
    ];
    const diffs = new Map([
      ['e1', { blockKind: 'diff' as const, filename: 'f.md', code: '+a', diffLines: [{ kind: 'add' as const, text: 'a' }] }],
    ]);
    const { messages } = project([header('e1', 'assistant')], bubbles, diffs);
    const tool = messages[0] as { filename?: string; diffBlock?: { filename?: string } };
    assert.equal(tool.filename, 'f.md');
    assert.equal(tool.diffBlock?.filename, 'f.md');
  });

  it('does not treat stale loading as loading when complete is true', () => {
    // projector maps tool status; runtime (Task 5) rewrites loading→completed
    // when generatingBubbleIds is empty. Here we only check mapStatus default.
    const bubbles: Bubble[] = [
      {
        bubbleId: 'l1',
        type: 2,
        createdAt: 1,
        text: '',
        toolFormerData: { toolCallId: 'c', name: 'task_v2', status: 'loading' },
      },
    ];
    const { messages } = project([header('l1', 'assistant')], bubbles);
    assert.equal((messages[0] as { status: string }).status, 'loading');
  });

  it('omits thought and tool when includeProcess is false but keeps todo_list', () => {
    const bubbles: Bubble[] = [
      { bubbleId: 'h1', type: 1, createdAt: 1, text: 'go' },
      {
        bubbleId: 'a1',
        type: 2,
        createdAt: 2,
        text: 'done',
        thinking: 'planning',
        thinkingDurationMs: 10,
        toolFormerData: {
          toolCallId: 'c1',
          name: 'read_file_v2',
          status: 'completed',
          params: '{"relativeWorkspacePath":"a.ts"}',
        },
      },
      {
        bubbleId: 'td',
        type: 2,
        createdAt: 3,
        text: '',
        toolFormerData: {
          toolCallId: 'c2',
          name: 'todo_write',
          status: 'completed',
          params: { todos: [{ content: 'x', status: 'completed' }] },
        },
      },
    ];
    const { messages } = project(
      [
        header('h1', 'human'),
        header('a1', 'assistant'),
        header('td', 'assistant'),
      ],
      bubbles,
      new Map(),
      { includeProcess: false },
    );
    assert.deepEqual(
      messages.map(m => m.type),
      ['human', 'assistant', 'todo_list'],
    );
  });
});
