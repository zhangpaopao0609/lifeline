import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const trace = process.argv[2];
const threadId = 'codex-provider-thread';
let turnId = '';
let seq = 0;
let initialized = false;
const waiting = new Map();
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params: { threadId, ...params } });
const item = (method, value) => notify(method, { turnId, item: value });
const finish = (status = 'completed') => notify('turn/completed', { turn: { id: turnId, status, error: status === 'failed' ? { message: 'private provider failure detail' } : null } });
const response = () => ({ thread: { id: threadId, historyMode: process.env.CODEX_FIXTURE_PAGINATED ? 'paginated' : 'legacy', turns: [] }, model: 'model-a', reasoningEffort: 'medium' });

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  assert.equal('jsonrpc' in frame, false, 'Codex wire must omit the ACP jsonrpc member');
  appendFileSync(trace, `${line}\n`);
  const { id, method, params = {} } = frame;
  if (method === 'initialize') {
    assert.equal(params.clientInfo.name, 'lifeline');
    reply(id, { userAgent: 'mock-codex' });
  }
  else if (method === 'initialized') {
    initialized = true;
  }
  else if (method === 'account/read') {
    assert.equal(initialized, true);
    reply(id, { requiresOpenaiAuth: true, account: process.env.CODEX_FIXTURE_NO_AUTH ? null : { type: 'chatgpt' } });
  }
  else if (method === 'model/list') {
    reply(id, {
      data: params.cursor
        ? [{ id: 'b', model: 'model-b', displayName: 'Model B', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }]
        : [{ id: 'a', model: 'model-a', displayName: 'Model A', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }],
      nextCursor: params.cursor ? null : 'second-page',
    });
  }
  else if (method === 'thread/start') {
    assert.equal(params.approvalPolicy, undefined, 'inherit local approval policy');
    assert.equal(params.sandbox, undefined, 'inherit local sandbox');
    reply(id, response());
  }
  else if (method === 'thread/resume') {
    assert.equal(params.threadId, threadId);
    assert.equal(params.excludeTurns, true);
    const result = response();
    if (!process.env.CODEX_FIXTURE_PAGINATED)
      result.thread.turns = [{ items: [{ type: 'userMessage', id: 'old-human', content: [{ type: 'text', text: 'Earlier question' }] }, { type: 'agentMessage', id: 'old-answer', text: 'Earlier answer' }] }];
    reply(id, result);
  }
  else if (method === 'thread/items/list') {
    assert.equal(params.sortDirection, 'desc');
    reply(id, { data: [{ item: params.cursor ? { type: 'userMessage', id: 'old-human', content: [{ type: 'text', text: 'Earlier question' }] } : { type: 'agentMessage', id: 'old-answer', text: 'Earlier answer' } }], nextCursor: params.cursor ? null : 'older-items' });
  }
  else if (method === 'turn/start') {
    turnId = `turn-${++seq}`;
    notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
    if (params.input[0].text === '__EARLY_STOP__') {
      setTimeout(reply, 30, id, { turn: { id: turnId, status: 'inProgress' } });
      continue;
    }
    reply(id, { turn: { id: turnId, status: 'inProgress' } });
    const prompt = params.input[0].text;
    if (prompt === '__COMPLETED_ONLY__') {
      item('item/completed', { type: 'agentMessage', id: 'answer', text: 'Completed without deltas' });
      item('item/completed', { type: 'agentMessage', id: 'answer', text: 'Completed without deltas' });
      notify('item/agentMessage/delta', { turnId, itemId: 'answer', delta: 'late duplicate' });
      finish(); continue;
    }
    if (prompt === '__CRASH__')
      process.exit(7);
    if (prompt === '__STOP__')
      continue;
    if (prompt === '__FAIL__') { finish('failed'); continue; }
    if (prompt === '__UNSUPPORTED__') {
      waiting.set('unsupported', () => finish('failed'));
      send({ id: 'unsupported', method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: [] } });
      continue;
    }
    if (prompt === '__APPROVAL__' || prompt === '__FILE__' || prompt === '__NETWORK__' || prompt === '__LARGE__') {
      const file = prompt === '__FILE__';
      const tool = { type: file ? 'fileChange' : 'commandExecution', id: 'operation', command: file ? undefined : 'npm test', cwd: '/work', changes: [{ path: '/work/marker.txt', diff: '+ok' }], status: 'inProgress' };
      item('item/started', tool);
      waiting.set('approval', (frame) => {
        assert.ok(['accept', 'decline', 'cancel'].includes(frame.result.decision));
        item('item/completed', { ...tool, status: frame.result.decision === 'accept' ? 'completed' : 'declined', aggregatedOutput: 'tool result' });
        finish();
      });
      send({ id: 'approval', method: file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: {
        threadId,
        turnId,
        itemId: tool.id,
        command: file ? undefined : prompt === '__LARGE__' ? 'x'.repeat(4500) : 'npm test',
        cwd: '/work',
        reason: 'Run project validation',
        ...(prompt === '__NETWORK__' ? { networkApprovalContext: { host: 'example.com', protocol: 'https' } } : {}),
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      } });
      continue;
    }
    send({ method: 'item/agentMessage/delta', params: { threadId: 'foreign-thread', itemId: 'foreign-item', delta: 'must not leak' } });
    notify('turn/plan/updated', { plan: [{ step: 'Reply', status: 'completed' }] });
    notify('item/agentMessage/delta', { turnId, itemId: 'answer', delta: 'Hello ' });
    notify('item/agentMessage/delta', { turnId, itemId: 'answer', delta: 'Codex' });
    item('item/completed', { type: 'agentMessage', id: 'answer', text: 'Hello Codex' });
    finish();
  }
  else if (method === 'turn/interrupt') {
    assert.equal(params.turnId, turnId);
    reply(id, {});
    finish('interrupted');
  }
  else if (method === 'thread/unsubscribe') {
    reply(id, { status: 'unsubscribed' });
  }
  else if (waiting.has(id)) {
    const callback = waiting.get(id);
    waiting.delete(id);
    callback(frame);
  }
  else {
    throw new Error(`Unsupported fixture request: ${method}`);
  }
}
