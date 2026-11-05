/**
 * Stand-in for `codex app-server` (JSON-RPC v2) for the Codex ACP bridge tests. Never calls a model.
 *
 *   mock-codex-app-server.mjs app-server                       one client on stdio
 *   mock-codex-app-server.mjs app-server --listen unix://<p>   shared: WebSocket over a unix socket,
 *                                                              any number of clients (writes <p>.pid)
 *
 * Shared mode behaves like the real server where it matters here: a client that starts or resumes a
 * thread is subscribed to it, its notifications and server requests go to every subscriber, the first
 * answer wins and the others get `serverRequest/resolved`.
 *
 * Env:
 *   MOCK_CODEX_SIGNED_OUT=1   account/read reports a required, missing OpenAI login
 *   MOCK_CODEX_TRACE=<file>   append every request a client sends (method + params)
 *   MOCK_CODEX_STATE=<file>   keep threads across processes (stdio mode: an agent restart)
 *
 * Prompt text drives the turn:
 *   contains "run"    → a command item that needs approval (declined → status declined)
 *   contains "slow"   → the turn stays in progress until `turn/interrupt`
 *   contains "wait"   → the turn stays in progress until a client sends `mock/release`
 *   otherwise         → reasoning + streamed reply "pong"
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import process from 'node:process';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] !== 'app-server') {
  process.stderr.write('usage: mock-codex-app-server.mjs app-server [--listen unix://<path>]\n');
  process.exit(2);
}
const listenAt = argv[1] === '--listen' ? argv[2] : undefined;

const STATE = process.env.MOCK_CODEX_STATE;
const threads = new Map(STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : []);
for (const thread of threads.values())
  thread.subscribers = new Set();
const pending = new Map();
let nextServerId = 1000;
let turnCounter = [...threads.values()].reduce((n, t) => n + t.turns.length, 0);

function save() {
  if (STATE)
    writeFileSync(STATE, JSON.stringify([...threads].map(([id, t]) => [id, { ...t, subscribers: undefined, turns: t.turns.map(({ release, ...turn }) => turn) }])));
}

function trace(method, params) {
  if (process.env.MOCK_CODEX_TRACE)
    appendFileSync(process.env.MOCK_CODEX_TRACE, `${JSON.stringify({ method, params })}\n`);
}

function broadcast(thread, method, params) {
  for (const conn of thread.subscribers)
    conn.send({ jsonrpc: '2.0', method, params });
}

/** Ask every subscriber; the first answer wins, the others hear `serverRequest/resolved`. */
function ask(thread, method, params) {
  const id = nextServerId++;
  const targets = [...thread.subscribers];
  return new Promise((resolve) => {
    pending.set(id, (from, result) => {
      pending.delete(id);
      for (const conn of targets) {
        if (conn !== from)
          conn.send({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId: thread.id, requestId: id } });
      }
      resolve(result);
    });
    for (const conn of targets)
      conn.send({ jsonrpc: '2.0', id, method, params });
  });
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

function finish(thread, turn, status) {
  turn.status = status;
  thread.persisted = true;
  save();
  broadcast(thread, 'turn/completed', { threadId: thread.id, turn: { id: turn.id, status, items: [], error: null } });
}

async function runTurn(thread, turn, text) {
  const turnId = turn.id;
  const tid = thread.id;
  broadcast(thread, 'turn/started', { threadId: tid, turn: { id: turnId, status: 'inProgress', items: [] } });
  const user = { type: 'userMessage', id: `${turnId}-u`, content: [{ type: 'text', text }] };
  broadcast(thread, 'item/started', { threadId: tid, turnId, item: user });
  broadcast(thread, 'item/completed', { threadId: tid, turnId, item: user });
  turn.items.push(user);
  broadcast(thread, 'item/reasoning/summaryTextDelta', { threadId: tid, turnId, itemId: `${turnId}-r`, delta: 'thinking…' });
  if (/slow/.test(text)) {
    await new Promise(resolve => (turn.release = resolve));
    finish(thread, turn, 'interrupted');
    return;
  }
  if (/wait/.test(text))
    await new Promise(resolve => (turn.release = resolve));
  if (/run/.test(text)) {
    const cmd = { type: 'commandExecution', id: `${turnId}-c`, command: '/bin/bash -lc \'echo hi > out.txt\'', cwd: thread.cwd, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null };
    broadcast(thread, 'item/started', { threadId: tid, turnId, item: cmd });
    turn.items.push(cmd);
    const answer = await ask(thread, 'item/commandExecution/requestApproval', { threadId: tid, turnId, itemId: cmd.id, command: 'echo hi > out.txt', cwd: thread.cwd, reason: 'write a file' });
    const accepted = answer?.decision === 'accept' || answer?.decision === 'acceptForSession';
    const doneCmd = accepted
      ? { ...cmd, status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0, durationMs: 12 }
      : { ...cmd, status: 'declined' };
    turn.items[turn.items.length - 1] = doneCmd;
    broadcast(thread, 'item/completed', { threadId: tid, turnId, item: doneCmd });
  }
  const msg = { type: 'agentMessage', id: `${turnId}-a`, text: 'pong' };
  broadcast(thread, 'item/started', { threadId: tid, turnId, item: { ...msg, text: '' } });
  broadcast(thread, 'item/agentMessage/delta', { threadId: tid, turnId, itemId: msg.id, delta: 'po' });
  broadcast(thread, 'item/agentMessage/delta', { threadId: tid, turnId, itemId: msg.id, delta: 'ng' });
  broadcast(thread, 'item/completed', { threadId: tid, turnId, item: msg });
  turn.items.push(msg);
  finish(thread, turn, 'completed');
}

function newThread(cwd) {
  const thread = { id: `thread-${threads.size + 1}`, cwd, turns: [], persisted: false, updatedAt: 1_800_000_000 + threads.size, subscribers: new Set() };
  threads.set(thread.id, thread);
  save();
  return thread;
}

function turnView(t, full) {
  return { id: t.id, status: t.status, error: null, items: full ? t.items : t.items.filter(i => i.type === 'userMessage' || i.type === 'agentMessage') };
}

function handle(conn, msg) {
  const { id, method, params = {} } = msg;
  if (method && id == null)
    return;
  if (!method) {
    pending.get(id)?.(conn, msg.result);
    return;
  }
  trace(method, params);
  const ok = result => conn.send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => conn.send({ jsonrpc: '2.0', id, error: { code, message } });
  const thread = params.threadId ? threads.get(params.threadId) : undefined;
  switch (method) {
    case 'initialize':
      return ok({ userAgent: 'mock-codex/0' });
    case 'account/read':
      return ok(process.env.MOCK_CODEX_SIGNED_OUT === '1'
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: 'apiKey' }, requiresOpenaiAuth: true });
    case 'model/list':
      return ok({ data: MODELS, nextCursor: null });
    case 'config/read':
      return ok({ config: { model: 'gpt-test', model_reasoning_effort: 'medium' } });
    case 'thread/start': {
      const t = newThread(params.cwd);
      t.subscribers.add(conn);
      return ok({ thread: { id: t.id, cwd: t.cwd, turns: [] }, model: params.model ?? 'gpt-test', reasoningEffort: 'medium' });
    }
    case 'thread/resume': {
      if (!thread?.persisted)
        return fail(-32600, `no rollout found for thread id ${params.threadId}`);
      thread.subscribers.add(conn);
      return ok({ thread: { id: thread.id, cwd: thread.cwd, turns: [] }, model: 'mini-test', reasoningEffort: 'low' });
    }
    case 'thread/unsubscribe':
      thread?.subscribers.delete(conn);
      return ok({});
    case 'thread/loaded/list':
      return ok({ data: [...threads.values()].filter(t => t.subscribers.size > 0).map(t => t.id) });
    case 'thread/list': {
      const rows = [...threads.values()]
        .filter(t => t.persisted && (!params.cwd || t.cwd === params.cwd))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(t => ({
          id: t.id,
          cwd: t.cwd,
          name: null,
          preview: t.turns[0]?.items.find(i => i.type === 'userMessage')?.content[0].text ?? '',
          updatedAt: t.updatedAt,
          status: { type: t.turns.some(x => x.status === 'inProgress') ? 'active' : 'idle' },
        }));
      return ok({ data: rows.slice(0, params.limit ?? 10), nextCursor: null });
    }
    case 'thread/turns/list': {
      const full = params.itemsView === 'full';
      const turns = (thread?.turns ?? []).slice().reverse().slice(0, params.limit ?? 10);
      return ok({ data: turns.map(t => turnView(t, full)), nextCursor: null, backwardsCursor: null });
    }
    case 'turn/start': {
      if (!thread)
        return fail(-32600, 'unknown thread');
      const turn = { id: `turn-${++turnCounter}`, status: 'inProgress', items: [], release: null };
      thread.turns.push(turn);
      thread.updatedAt += 100;
      ok({ turn: { id: turn.id, status: 'inProgress', items: [], error: null } });
      void runTurn(thread, turn, params.input?.[0]?.text ?? '');
      return;
    }
    case 'turn/interrupt': {
      thread?.turns.find(t => t.id === params.turnId)?.release?.();
      return ok({});
    }
    case 'mock/release': {
      for (const t of threads.values()) {
        for (const turn of t.turns)
          turn.release?.();
      }
      return ok({});
    }
    default:
      return fail(-32601, `mock: ${method}`);
  }
}

function dropConnection(conn) {
  for (const t of threads.values())
    t.subscribers.delete(conn);
}

// ---------- stdio ----------

if (!listenAt) {
  const conn = { send: msg => process.stdout.write(`${JSON.stringify(msg)}\n`) };
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim())
      handle(conn, JSON.parse(line));
  });
}

// ---------- WebSocket over a unix socket ----------

function wsFrame(text) {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  }
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

if (listenAt) {
  const path = listenAt.replace(/^unix:\/\//, '');
  rmSync(path, { force: true });
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let open = false;
    const conn = { send: msg => sock.writable && sock.write(wsFrame(JSON.stringify(msg))) };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0)
          return;
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        const key = /Sec-WebSocket-Key: *(\S+)/i.exec(head)?.[1] ?? '';
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        open = true;
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0F;
        let len = buf[1] & 0x7F;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4)
            return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        else if (len === 127) {
          if (buf.length < 10)
            return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + 4 + len)
          return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++)
          payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (opcode === 0x8) {
          sock.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode === 0x1)
          handle(conn, JSON.parse(payload.toString('utf8')));
      }
    });
    sock.on('close', () => dropConnection(conn));
    sock.on('error', () => dropConnection(conn));
  });
  server.listen(path, () => writeFileSync(`${path}.pid`, String(process.pid)));
  const stop = () => {
    rmSync(path, { force: true });
    rmSync(`${path}.pid`, { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
