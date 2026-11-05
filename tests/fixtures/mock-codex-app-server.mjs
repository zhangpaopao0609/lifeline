/**
 * Stand-in for `codex app-server` (JSON-RPC v2 over stdio) for the Codex ACP bridge tests.
 * Never calls a model. Invoked as `<node> mock-codex-app-server.mjs app-server`.
 *
 * Env:
 *   MOCK_CODEX_SIGNED_OUT=1   account/read reports a required, missing OpenAI login
 *   MOCK_CODEX_TRACE=<file>   append every request the bridge sends (method + params)
 *   MOCK_CODEX_STATE=<file>   keep threads across processes (an agent restart between new and load)
 *
 * Prompt text drives the turn:
 *   contains "run"    → a command item that needs approval (declined → status declined)
 *   contains "slow"   → the turn stays in progress until `turn/interrupt`
 *   otherwise         → reasoning + streamed reply "pong"
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

if (process.argv[2] !== 'app-server') {
  process.stderr.write('usage: mock-codex-app-server.mjs app-server\n');
  process.exit(2);
}

const STATE = process.env.MOCK_CODEX_STATE;
const threads = new Map(STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : []);

function save() {
  if (STATE)
    writeFileSync(STATE, JSON.stringify([...threads].map(([id, t]) => [id, { ...t, turns: t.turns.map(({ release, ...turn }) => turn) }])));
}
const pending = new Map();
let nextServerId = 1000;
let turnCounter = [...threads.values()].reduce((n, t) => n + t.turns.length, 0);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function ask(method, params) {
  const id = nextServerId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise(resolve => pending.set(id, resolve));
}

function trace(method, params) {
  if (process.env.MOCK_CODEX_TRACE)
    appendFileSync(process.env.MOCK_CODEX_TRACE, `${JSON.stringify({ method, params })}\n`);
}

const MODELS = [
  {
    id: 'gpt-test',
    model: 'gpt-test',
    displayName: 'GPT Test',
    description: 'default test model',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
  },
  {
    id: 'mini-test',
    model: 'mini-test',
    displayName: 'Mini Test',
    description: '',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  },
  { id: 'hidden-test', model: 'hidden-test', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [] },
];

function threadOf(id) {
  return threads.get(id);
}

function finish(thread, turn, status) {
  turn.status = status;
  thread.persisted = true;
  save();
  notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, status, items: [], error: null } });
}

async function runTurn(thread, turn, text) {
  const turnId = turn.id;
  notify('turn/started', { threadId: thread.id, turn: { id: turnId, status: 'inProgress', items: [] } });
  const user = { type: 'userMessage', id: `${turnId}-u`, content: [{ type: 'text', text }] };
  notify('item/started', { threadId: thread.id, turnId, item: user });
  notify('item/completed', { threadId: thread.id, turnId, item: user });
  turn.items.push(user);
  notify('item/reasoning/summaryTextDelta', { threadId: thread.id, turnId, itemId: `${turnId}-r`, delta: 'thinking…' });
  if (/slow/.test(text)) {
    await new Promise(resolve => (turn.release = resolve));
    finish(thread, turn, 'interrupted');
    return;
  }
  if (/run/.test(text)) {
    const cmd = { type: 'commandExecution', id: `${turnId}-c`, command: '/bin/bash -lc \'echo hi > out.txt\'', cwd: thread.cwd, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null };
    notify('item/started', { threadId: thread.id, turnId, item: cmd });
    const answer = await ask('item/commandExecution/requestApproval', { threadId: thread.id, turnId, itemId: cmd.id, command: 'echo hi > out.txt', cwd: thread.cwd, reason: 'write a file' });
    const accepted = answer?.decision === 'accept' || answer?.decision === 'acceptForSession';
    const doneCmd = accepted
      ? { ...cmd, status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0, durationMs: 12 }
      : { ...cmd, status: 'declined' };
    notify('item/completed', { threadId: thread.id, turnId, item: doneCmd });
    turn.items.push(doneCmd);
  }
  const msg = { type: 'agentMessage', id: `${turnId}-a`, text: 'pong' };
  notify('item/started', { threadId: thread.id, turnId, item: { ...msg, text: '' } });
  notify('item/agentMessage/delta', { threadId: thread.id, turnId, itemId: msg.id, delta: 'po' });
  notify('item/agentMessage/delta', { threadId: thread.id, turnId, itemId: msg.id, delta: 'ng' });
  notify('item/completed', { threadId: thread.id, turnId, item: msg });
  turn.items.push(msg);
  finish(thread, turn, 'completed');
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method && id == null)
    return;
  if (!method) {
    pending.get(id)?.(msg.result);
    pending.delete(id);
    return;
  }
  trace(method, params);
  const ok = result => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({ userAgent: 'mock-codex/0' });
    case 'account/read':
      return ok(process.env.MOCK_CODEX_SIGNED_OUT === '1'
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: 'apiKey' }, requiresOpenaiAuth: true });
    case 'model/list':
      return ok({ data: MODELS, nextCursor: null });
    case 'thread/start': {
      const thread = { id: `thread-${threads.size + 1}`, cwd: params.cwd, turns: [], persisted: false };
      threads.set(thread.id, thread);
      save();
      return ok({ thread: { id: thread.id, cwd: thread.cwd, turns: [] }, model: 'gpt-test', reasoningEffort: 'medium' });
    }
    case 'thread/resume': {
      const thread = threadOf(params.threadId);
      if (!thread?.persisted)
        return fail(-32600, `no rollout found for thread id ${params.threadId}`);
      return ok({ thread: { id: thread.id, cwd: thread.cwd, turns: [] }, model: 'mini-test', reasoningEffort: 'low' });
    }
    case 'thread/turns/list': {
      const thread = threadOf(params.threadId);
      const turns = (thread?.turns ?? []).slice().reverse().slice(0, params.limit ?? 10);
      return ok({
        data: turns.map(t => ({ id: t.id, status: t.status, error: null, items: t.items.filter(i => i.type === 'userMessage' || i.type === 'agentMessage') })),
        nextCursor: null,
        backwardsCursor: null,
      });
    }
    case 'turn/start': {
      const thread = threadOf(params.threadId);
      if (!thread)
        return fail(-32600, 'unknown thread');
      const turn = { id: `turn-${++turnCounter}`, status: 'inProgress', items: [], release: null };
      thread.turns.push(turn);
      ok({ turn: { id: turn.id, status: 'inProgress', items: [], error: null } });
      void runTurn(thread, turn, params.input?.[0]?.text ?? '');
      return;
    }
    case 'turn/interrupt': {
      const turn = threadOf(params.threadId)?.turns.find(t => t.id === params.turnId);
      turn?.release?.();
      return ok({});
    }
    default:
      return fail(-32601, `mock: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim())
    void handle(JSON.parse(line));
});
