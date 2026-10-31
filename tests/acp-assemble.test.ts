import type { ChatElement } from '@lifeline/protocol';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chatElementSchema,
  CLI_ELEMENT_MAX_BYTES,
  CLI_SESSION_BODY_MAX_BYTES,
  CLI_SESSION_BODY_MAX_ELEMENTS,
  wireBytes,
} from '@lifeline/protocol';
import { AcpTimelineAssembler } from '../packages/agent/src/drivers/acp/assemble.js';

function agentChunk(messageId: string | undefined, text: string) {
  return {
    sessionUpdate: 'agent_message_chunk',
    ...(messageId === undefined ? {} : { messageId }),
    content: { type: 'text' as const, text },
  };
}

function thoughtChunk(messageId: string | undefined, text: string) {
  return {
    sessionUpdate: 'agent_thought_chunk',
    ...(messageId === undefined ? {} : { messageId }),
    content: { type: 'text' as const, text },
  };
}

function take(assembler: AcpTimelineAssembler) {
  const view = assembler.snapshot();
  for (const message of view.messages) {
    const parsed = chatElementSchema.safeParse(message);
    assert.equal(parsed.success, true, parsed.success ? message.type : parsed.error.message);
    assert.ok(wireBytes(message) <= CLI_ELEMENT_MAX_BYTES);
  }
  return view;
}

function at(messages: ChatElement[], index: number): ChatElement {
  const message = messages[index];
  assert.ok(message);
  return message;
}

/** One code point longer than `suffix`, when `suffix` is a suffix of `original`. */
function oneCodePointLonger(original: string, suffix: string): string | undefined {
  const start = original.length - suffix.length;
  if (start <= 0)
    return undefined;
  let prev = start - 1;
  const code = original.charCodeAt(prev);
  if (code >= 0xDC00 && code <= 0xDFFF)
    prev -= 1;
  return original.slice(Math.max(prev, 0));
}

describe('AcpTimelineAssembler', () => {
  it('ignores a live user chunk and keeps a replayed one', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'live' } });
    assert.equal(assembler.snapshot().messages.length, 0);
    assembler.apply(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'saved' } },
      { replayUser: true },
    );
    const { messages } = take(assembler);
    const message = at(messages, 0);
    assert.equal(message.type, 'human');
    if (message.type === 'human')
      assert.equal(message.text, 'saved');
  });

  it('restores a replayed slash command and leaves an injected caveat as replay text', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(
      {
        sessionUpdate: 'user_message_chunk',
        content: {
          type: 'text',
          text: '<command-message>diagnose</command-message>\n<command-name>/diagnose</command-name>\n<command-args>recently the PR data does not update</command-args>',
        },
      },
      { replayUser: true },
    );
    const { messages } = take(assembler);
    assert.equal(messages.length, 1);
    const message = at(messages, 0);
    assert.equal(message.type, 'human');
    if (message.type === 'human')
      assert.equal(message.text, '/diagnose recently the PR data does not update');
  });

  it('returns an empty message list from snapshot and trim', () => {
    const assembler = new AcpTimelineAssembler();
    const empty = {
      messages: [],
      truncatedBefore: false,
      firstRetainedFlatIndex: null,
    };
    assert.deepEqual(assembler.snapshot(), empty);
    assert.deepEqual(assembler.trim(), empty);
  });

  it('merges consecutive chunks that share a messageId into one assistant', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk('m1', 'hel'));
    assembler.apply(agentChunk('m1', 'lo'));
    const { messages } = take(assembler);
    assert.deepEqual(messages, [{
      type: 'assistant',
      id: 'assistant:m1:0',
      flatIndex: 0,
      text: 'hello',
    }]);
  });

  it('splits adjacent chunks that use different messageIds', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk('m1', 'a'));
    assembler.apply(agentChunk('m2', 'b'));
    const { messages } = take(assembler);
    assert.deepEqual(messages, [
      { type: 'assistant', id: 'assistant:m1:0', flatIndex: 0, text: 'a' },
      { type: 'assistant', id: 'assistant:m2:0', flatIndex: 1, text: 'b' },
    ]);
  });

  it('merges consecutive chunks that have no messageId into one fallback segment', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk(undefined, 'a'));
    assembler.apply(agentChunk(undefined, 'b'));
    const { messages } = take(assembler);
    assert.deepEqual(messages, [{
      type: 'assistant',
      id: 'assistant:fallback:0',
      flatIndex: 0,
      text: 'ab',
    }]);
  });

  it('does not merge a fallback segment with a neighboring messageId segment', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk(undefined, 'a'));
    assembler.apply(agentChunk('m1', 'b'));
    assembler.apply(agentChunk(undefined, 'c'));
    const { messages } = take(assembler);
    assert.deepEqual(messages.map(message => message.id), [
      'assistant:fallback:0',
      'assistant:m1:0',
      'assistant:fallback:1',
    ]);
    assert.deepEqual(messages.map(message => message.type === 'assistant' ? message.text : ''), ['a', 'b', 'c']);
  });

  it('closes the open assistant when a tool call is created and starts a new one after it', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk('m1', 'before'));
    assembler.apply(agentChunk(undefined, 'tail'));
    assembler.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read',
      kind: 'read',
      status: 'pending',
    });
    assembler.apply(agentChunk('m1', 'after'));
    assembler.apply(agentChunk(undefined, 'more'));
    const { messages } = take(assembler);
    assert.deepEqual(messages.map(message => message.id), [
      'assistant:m1:0',
      'assistant:fallback:0',
      'tool:t1',
      'assistant:m1:1',
      'assistant:fallback:1',
    ]);
    const tool = at(messages, 2);
    assert.equal(tool.type, 'tool');
    if (tool.type !== 'tool')
      return;
    assert.equal(tool.toolCallId, 't1');
    assert.equal(tool.status, 'loading');
    assert.equal(tool.action, 'Read');
    assert.equal(tool.details, '');
    assert.equal(tool.flatIndex, 2);
    const after = at(messages, 3);
    assert.equal(after.type, 'assistant');
    if (after.type === 'assistant')
      assert.equal(after.text, 'after');
  });

  it('updates an existing tool in place and does not split the surrounding assistant', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read',
      name: 'read_file',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: '/tmp/a.ts', line: 3 }],
      content: [
        { type: 'content', content: { type: 'text', text: 'file body' } },
        { type: 'diff', path: '/tmp/a.ts', oldText: 'a', newText: 'b' },
        { type: 'terminal', terminalId: 'term-1' },
      ],
    });
    assembler.apply(agentChunk('m1', 'hel'));
    assembler.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      title: 'Read done',
    });
    assembler.apply(agentChunk('m1', 'lo'));
    const { messages } = take(assembler);
    assert.equal(messages.length, 2);
    const tool = at(messages, 0);
    assert.equal(tool.type, 'tool');
    if (tool.type !== 'tool')
      return;
    assert.equal(tool.id, 'tool:t1');
    assert.equal(tool.flatIndex, 0);
    assert.equal(tool.status, 'completed');
    assert.equal(tool.action, 'Read done');
    assert.equal(tool.details, 'file body');
    assert.equal(tool.toolName, 'read_file');
    assert.equal(tool.filename, '/tmp/a.ts');
    assert.equal(tool.diffBlock, undefined);
    assert.deepEqual(messages[1], {
      type: 'assistant',
      id: 'assistant:m1:0',
      flatIndex: 1,
      text: 'hello',
    });
  });

  it('creates a placeholder when a tool update arrives first and treats it as a boundary', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk(undefined, 'a'));
    assembler.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'in_progress',
      title: 'Grep',
      kind: 'search',
    });
    assembler.apply(agentChunk(undefined, 'b'));
    assembler.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't9',
      status: 'failed',
      title: 'Grep failed',
    });
    assembler.apply(agentChunk(undefined, 'c'));
    const { messages } = take(assembler);
    assert.deepEqual(messages.map(message => message.id), [
      'assistant:fallback:0',
      'tool:t9',
      'assistant:fallback:1',
    ]);
    const tool = at(messages, 1);
    assert.equal(tool.type, 'tool');
    if (tool.type !== 'tool')
      return;
    assert.equal(tool.flatIndex, 1);
    assert.equal(tool.status, 'error');
    assert.equal(tool.action, 'Grep failed');
    assert.equal(tool.toolCallId, 't9');
    const tail = at(messages, 2);
    assert.equal(tail.type, 'assistant');
    if (tail.type === 'assistant')
      assert.equal(tail.text, 'bc');
  });

  it('maps tool statuses onto the chat element status set and keeps unknown updates', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      kind: 'execute',
      status: 'mystery',
      content: [{ type: 'content', content: { type: 'text', text: 'stdout' } }],
    });
    assembler.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'nope' });
    let tool = at(take(assembler).messages, 0);
    assert.equal(tool.type, 'tool');
    if (tool.type !== 'tool')
      return;
    assert.equal(tool.status, 'loading');
    assert.equal(tool.action, 'execute');
    assert.equal(tool.details, 'stdout');
    assembler.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'cancelled' });
    tool = at(take(assembler).messages, 0);
    assert.equal(tool.type, 'tool');
    if (tool.type !== 'tool')
      return;
    assert.equal(tool.status, 'cancelled');
    assembler.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'xx' } }],
    });
    tool = at(take(assembler).messages, 0);
    assert.equal(tool.type, 'tool');
    if (tool.type !== 'tool')
      return;
    assert.equal(tool.status, 'completed');
    assert.equal(tool.details, '');
    assert.equal(tool.flatIndex, 0);
  });

  it('maps a thought to its own element and closes the assistant segment', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk('m1', 'a'));
    assembler.apply(thoughtChunk('th1', 'h'));
    assembler.apply(thoughtChunk('th1', 'mm'));
    assembler.apply(agentChunk('m1', 'b'));
    assembler.apply(thoughtChunk('th1', '!'));
    const { messages } = take(assembler);
    assert.deepEqual(messages.map(message => message.id), [
      'assistant:m1:0',
      'thought:th1',
      'assistant:m1:1',
    ]);
    const thought = at(messages, 1);
    assert.equal(thought.type, 'thought');
    if (thought.type !== 'thought')
      return;
    assert.equal(thought.flatIndex, 1);
    assert.equal(thought.detail, 'hmm!');
    assert.equal(thought.duration, '');
    assert.equal(thought.thoughtKind, 'thinking_step');
    assert.equal(at(messages, 0).type === 'assistant' && at(messages, 0).text, 'a');
    assert.equal(at(messages, 2).type === 'assistant' && at(messages, 2).text, 'b');
  });

  it('numbers thoughts that have no id and starts a new one after the segment closes', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(thoughtChunk(undefined, 'x'));
    assembler.apply(thoughtChunk(undefined, 'y'));
    assembler.apply(agentChunk(undefined, 'z'));
    assembler.apply(thoughtChunk(undefined, 'w'));
    const { messages } = take(assembler);
    assert.deepEqual(messages.map(message => message.id), [
      'thought:1',
      'assistant:fallback:0',
      'thought:2',
    ]);
    assert.equal(at(messages, 0).type === 'thought' && at(messages, 0).detail, 'xy');
    assert.equal(at(messages, 2).type === 'thought' && at(messages, 2).detail, 'w');
  });

  it('replaces the turn plan in place and does not let plan or metadata split an assistant', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk('m', 'hel'));
    assembler.apply({
      sessionUpdate: 'plan',
      entries: [{ content: 'one', priority: 'high', status: 'pending' }],
    });
    assembler.apply({ sessionUpdate: 'usage_update', used: 1, size: 10 });
    assembler.apply({ sessionUpdate: 'session_info_update', title: 'Session' });
    assembler.apply({ sessionUpdate: 'available_commands_update', availableCommands: [] });
    assembler.apply({ sessionUpdate: 'current_mode_update', currentModeId: 'agent' });
    assembler.apply({ sessionUpdate: 'future_variant', raw: { ok: true } });
    assembler.apply(agentChunk('m', 'lo'));
    assembler.apply({
      sessionUpdate: 'plan',
      entries: [
        { content: 'one', priority: 'high', status: 'completed' },
        { content: 'two', priority: 'low', status: 'in_progress' },
        { content: 'skip', priority: 'low', status: 'cancelled' },
      ],
    });
    const { messages } = take(assembler);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], {
      type: 'assistant',
      id: 'assistant:m:0',
      flatIndex: 0,
      text: 'hello',
    });
    const plan = at(messages, 1);
    assert.equal(plan.type, 'plan');
    if (plan.type !== 'plan')
      return;
    assert.equal(plan.id, 'plan:1');
    assert.equal(plan.flatIndex, 1);
    assert.equal(plan.label, 'Plan');
    assert.equal(plan.title, 'one');
    assert.equal(plan.todosCompleted, 1);
    assert.equal(plan.todosTotal, 3);
    assert.deepEqual(plan.todos, [
      { text: 'one', status: 'completed' },
      { text: 'two', status: 'in_progress' },
      { text: 'skip', status: 'pending' },
    ]);
    assembler.endTurn();
    assembler.apply({
      sessionUpdate: 'plan',
      entries: [{ content: 'next', priority: 'medium', status: 'pending' }],
    });
    const again = take(assembler);
    assert.equal(again.messages.length, 3);
    assert.equal(again.messages[1]?.id, 'plan:1');
    assert.equal(again.messages[1]?.flatIndex, 1);
    assert.equal(again.messages[2]?.id, 'plan:2');
    assert.equal(again.messages[2]?.flatIndex, 2);
  });

  it('ignores a non-text block without cutting the current assistant', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk('m', 'a'));
    assembler.apply({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm',
      content: { type: 'image', mimeType: 'image/png', data: 'xx' },
    });
    assembler.apply({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'resource', resource: { uri: 'file:///tmp/a' } },
    });
    assembler.apply(agentChunk('m', 'b'));
    const { messages } = take(assembler);
    assert.deepEqual(messages, [{
      type: 'assistant',
      id: 'assistant:m:0',
      flatIndex: 0,
      text: 'ab',
    }]);
  });

  it('suppresses user chunks by clientMessageId and does not backfill a human', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply({
      sessionUpdate: 'user_message_chunk',
      clientMessageId: 'c-missing',
      messageId: 'echo-1',
      content: { type: 'text', text: 'only echo' },
    });
    assert.deepEqual(assembler.snapshot().messages, []);
    assembler.appendHuman({ clientMessageId: 'c1', text: 'hi' });
    assembler.apply(agentChunk('m', 'a'));
    assembler.apply({
      sessionUpdate: 'user_message_chunk',
      clientMessageId: 'c1',
      content: { type: 'text', text: 'ECHO' },
    });
    assembler.apply({
      sessionUpdate: 'user_message_chunk',
      clientMessageId: 'c2',
      messageId: 'c1',
      content: { type: 'text', text: 'hi' },
    });
    assembler.apply(agentChunk('m', 'b'));
    const { messages } = take(assembler);
    assert.deepEqual(messages, [
      { type: 'human', id: 'human:c1', flatIndex: 0, text: 'hi', mentions: [] },
      { type: 'assistant', id: 'assistant:m:0', flatIndex: 1, text: 'ab' },
    ]);
  });

  it('starts a new fallback segment after a human and after endTurn', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk(undefined, 'a'));
    assembler.appendHuman({ clientMessageId: 'c1', text: 'hi' });
    assembler.apply(agentChunk(undefined, 'b'));
    assembler.endTurn();
    assembler.apply(agentChunk('m', 'c'));
    assembler.endTurn();
    assembler.apply(agentChunk('m', 'd'));
    assembler.appendHuman({ clientMessageId: 'c1', text: 'edited' });
    const { messages } = take(assembler);
    assert.deepEqual(messages.map(message => [message.id, message.type === 'human' || message.type === 'assistant' ? message.text : '']), [
      ['assistant:fallback:0', 'a'],
      ['human:c1', 'edited'],
      ['assistant:fallback:1', 'b'],
      ['assistant:m:0', 'c'],
      ['assistant:m:1', 'd'],
    ]);
    assert.equal(at(messages, 1).flatIndex, 1);
  });

  it('assigns a flatIndex once and keeps prefixed ids stable across in-place updates', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.appendHuman({ clientMessageId: 'c1', text: 'hi' });
    assembler.apply(agentChunk('m', 'a'));
    assembler.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', status: 'pending' });
    assembler.apply(thoughtChunk('th', 'think'));
    assembler.apply({
      sessionUpdate: 'plan',
      entries: [{ content: 'step', priority: 'high', status: 'pending' }],
    });
    assembler.apply(agentChunk('m', 'b'));
    assembler.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    assembler.apply({
      sessionUpdate: 'plan',
      entries: [{ content: 'step', priority: 'high', status: 'completed' }],
    });
    const { messages, truncatedBefore, firstRetainedFlatIndex } = take(assembler);
    assert.equal(truncatedBefore, false);
    assert.equal(firstRetainedFlatIndex, 0);
    assert.deepEqual(messages.map(message => [message.id, message.flatIndex]), [
      ['human:c1', 0],
      ['assistant:m:0', 1],
      ['tool:t1', 2],
      ['thought:th', 3],
      ['plan:1', 4],
      ['assistant:m:1', 5],
    ]);
    const tool = at(messages, 2);
    const plan = at(messages, 4);
    assert.equal(tool.type, 'tool');
    assert.equal(plan.type, 'plan');
    if (tool.type === 'tool')
      assert.equal(tool.status, 'completed');
    if (plan.type === 'plan')
      assert.equal(plan.todosCompleted, 1);
  });

  it('ignores malformed updates instead of throwing', () => {
    const assembler = new AcpTimelineAssembler();
    assert.doesNotThrow(() => {
      assembler.apply(null);
      assembler.apply(undefined);
      assembler.apply('nope');
      assembler.apply([]);
      assembler.apply({ sessionUpdate: 'agent_message_chunk' });
      assembler.apply({ sessionUpdate: 'agent_message_chunk', content: [] });
      assembler.apply({ sessionUpdate: 'tool_call' });
      assembler.apply({ sessionUpdate: 'tool_call', toolCallId: '' });
      assembler.apply({ sessionUpdate: 'tool_call_update', title: 'x' });
      assembler.apply({ sessionUpdate: 'plan' });
      assembler.apply({ sessionUpdate: 'plan', entries: [{ content: 1, status: 'pending' }] });
      assembler.apply({ sessionUpdate: 'plan', entries: 'nope' });
    });
    assert.deepEqual(assembler.snapshot().messages, []);
    assembler.apply(agentChunk('m', 'ok'));
    assert.equal(take(assembler).messages[0]?.type === 'assistant' && take(assembler).messages[0]?.text, 'ok');
  });

  it('keeps the tail of an element that exceeds 1 MiB', () => {
    const head = 'A'.repeat(32);
    const body = `${'😀'.repeat(CLI_ELEMENT_MAX_BYTES)}TAIL`;
    const original = head + body;
    const assembler = new AcpTimelineAssembler();
    assembler.apply(agentChunk('m', head));
    assembler.apply(agentChunk('m', body));
    const message = at(take(assembler).messages, 0);
    assert.equal(message.type, 'assistant');
    if (message.type !== 'assistant')
      return;
    assert.equal(message.id, 'assistant:m:0');
    assert.equal(message.flatIndex, 0);
    assert.ok(wireBytes(message) <= CLI_ELEMENT_MAX_BYTES);
    assert.equal(original.endsWith(message.text), true);
    assert.equal(message.text.endsWith('TAIL'), true);
    assert.equal(message.text.startsWith('A'), false);
    assert.equal(message.text.includes('😀'), true);
    const longer = oneCodePointLonger(original, message.text);
    assert.ok(longer);
    assert.ok(wireBytes({ ...message, text: longer }) > CLI_ELEMENT_MAX_BYTES);
    for (let i = 0; i < message.text.length; i++) {
      const code = message.text.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const pair = message.text.charCodeAt(i + 1);
        assert.equal(pair >= 0xDC00 && pair <= 0xDFFF, true);
      }
    }
  });

  it('keeps the tail of a human element that exceeds 1 MiB', () => {
    const original = `${'H'.repeat(CLI_ELEMENT_MAX_BYTES)}END`;
    const assembler = new AcpTimelineAssembler();
    assembler.appendHuman({ clientMessageId: 'c1', text: original });
    const message = at(take(assembler).messages, 0);
    assert.equal(message.type, 'human');
    if (message.type !== 'human')
      return;
    assert.equal(message.id, 'human:c1');
    assert.deepEqual(message.mentions, []);
    assert.equal(original.endsWith(message.text), true);
    assert.equal(message.text.endsWith('END'), true);
    assert.ok(wireBytes(message) <= CLI_ELEMENT_MAX_BYTES);
    const longer = oneCodePointLonger(original, message.text);
    assert.ok(longer);
    assert.ok(wireBytes({ ...message, text: longer }) > CLI_ELEMENT_MAX_BYTES);
  });

  it('keeps a plan with more than eight large text fields within 1 MiB', () => {
    const count = 9;
    const contents = Array.from({ length: count }, (_, i) => `${'p'.repeat(CLI_ELEMENT_MAX_BYTES)}#${i}`);
    const assembler = new AcpTimelineAssembler();
    assembler.apply({
      sessionUpdate: 'plan',
      entries: contents.map(content => ({ content, priority: 'high', status: 'pending' as const })),
    });
    const { messages } = assembler.snapshot();
    assert.equal(messages.length, 1);
    const plan = messages[0];
    assert.equal(plan?.type, 'plan');
    assert.equal(chatElementSchema.safeParse(plan).success, true);
    assert.ok(plan);
    assert.ok(wireBytes(plan) <= CLI_ELEMENT_MAX_BYTES);
    if (plan?.type !== 'plan')
      return;
    assert.ok(plan.title.length > 0);
    assert.equal(contents[0]?.endsWith(plan.title), true);
    assert.equal(plan.todos?.length, count);
    plan.todos?.forEach((todo, index) => {
      assert.ok(todo.text.length > 0, `todo ${index} kept an empty suffix`);
      assert.equal(contents[index]?.endsWith(todo.text), true);
    });
    assert.ok(wireBytes(plan) > CLI_ELEMENT_MAX_BYTES - 256);
  });

  it('drops an element that stays over 1 MiB after every text field is cleared', () => {
    const assembler = new AcpTimelineAssembler();
    assembler.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't'.repeat(CLI_ELEMENT_MAX_BYTES),
      title: 'run',
      status: 'pending',
    });
    assert.equal(assembler.snapshot().messages.length, 0);
  });

  it('does not drop history at exactly 2000 elements', () => {
    const assembler = new AcpTimelineAssembler();
    for (let i = 0; i < CLI_SESSION_BODY_MAX_ELEMENTS; i++)
      assembler.apply(agentChunk(`m${i}`, 'x'));
    const view = assembler.trim();
    assert.equal(view.truncatedBefore, false);
    assert.equal(view.messages.length, CLI_SESSION_BODY_MAX_ELEMENTS);
    assert.equal(view.firstRetainedFlatIndex, 0);
    assert.equal(view.messages[0]?.id, 'assistant:m0:0');
    assert.equal(view.messages.at(-1)?.id, `assistant:m${CLI_SESSION_BODY_MAX_ELEMENTS - 1}:0`);
  });

  it('drops the head when the element count exceeds 2000 and does not reuse flatIndex', () => {
    const assembler = new AcpTimelineAssembler();
    const count = CLI_SESSION_BODY_MAX_ELEMENTS + 1;
    for (let i = 0; i < count; i++)
      assembler.apply(agentChunk(`m${i}`, String(i)));
    const before = assembler.snapshot();
    assert.equal(before.truncatedBefore, false);
    assert.equal(before.messages.length, count);
    const trimmed = assembler.trim();
    assert.equal(trimmed.truncatedBefore, true);
    assert.equal(trimmed.messages.length, CLI_SESSION_BODY_MAX_ELEMENTS);
    assert.equal(trimmed.messages[0]?.type === 'assistant' && trimmed.messages[0].text, '1');
    assert.equal(trimmed.messages.at(-1)?.type === 'assistant' && trimmed.messages.at(-1)?.text, String(count - 1));
    assert.equal(trimmed.firstRetainedFlatIndex, trimmed.messages[0]?.flatIndex);
    assert.equal(trimmed.messages[0]?.flatIndex, 1);
    assert.equal(chatElementSchema.safeParse(trimmed.messages[0]).success, true);
    assert.equal(assembler.snapshot().truncatedBefore, true);
    assembler.apply(agentChunk('fresh', 'tail'));
    const again = assembler.trim();
    assert.equal(again.truncatedBefore, true);
    assert.equal(again.messages.length, CLI_SESSION_BODY_MAX_ELEMENTS);
    assert.equal(again.messages[0]?.flatIndex, 2);
    assert.equal(again.firstRetainedFlatIndex, 2);
    const last = again.messages.at(-1);
    assert.equal(last?.id, 'assistant:fresh:0');
    assert.equal(last?.flatIndex, count);
    assert.deepEqual(assembler.snapshot().messages.map(message => message.flatIndex), again.messages.map(message => message.flatIndex));
  });

  it('drops the head when the body exceeds 8 MiB and keeps the tail', () => {
    const assembler = new AcpTimelineAssembler();
    const text = 'y'.repeat(900 * 1024);
    let i = 0;
    while (wireBytes(assembler.snapshot().messages) <= CLI_SESSION_BODY_MAX_BYTES) {
      assembler.apply(agentChunk(`b${i}`, text));
      i += 1;
      assert.ok(i < 30);
    }
    const before = assembler.snapshot();
    assert.equal(before.truncatedBefore, false);
    assert.ok(before.messages.length < CLI_SESSION_BODY_MAX_ELEMENTS);
    assert.ok(wireBytes(before.messages) > CLI_SESSION_BODY_MAX_BYTES);
    const firstId = before.messages[0]?.id;
    const lastId = before.messages.at(-1)?.id;
    const trimmed = assembler.trim();
    assert.equal(trimmed.truncatedBefore, true);
    assert.equal(trimmed.messages.at(-1)?.id, lastId);
    assert.equal(trimmed.messages.some(message => message.id === firstId), false);
    assert.ok(trimmed.messages.length >= 1);
    assert.ok(wireBytes(trimmed.messages) <= CLI_SESSION_BODY_MAX_BYTES);
    assert.ok(trimmed.messages.length <= CLI_SESSION_BODY_MAX_ELEMENTS);
    assert.equal(trimmed.firstRetainedFlatIndex, trimmed.messages[0]?.flatIndex);
    assert.ok((trimmed.firstRetainedFlatIndex ?? 0) > 0);
    for (const message of trimmed.messages)
      assert.equal(chatElementSchema.safeParse(message).success, true);
  });
});
