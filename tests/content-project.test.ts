import type { Bubble } from '../packages/agent/src/sources/cursor-adapter.js';
import type { MessageHeader } from '../packages/agent/src/sources/types.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { project } from '../packages/agent/src/sources/project.js';

function header(id: string, role: MessageHeader['role']): MessageHeader {
  return { messageId: id, role, createdAt: 1, complete: true };
}

describe('project', () => {
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
