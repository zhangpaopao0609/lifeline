import type { AcpClientEvent, AcpPermissionEvent } from '../packages/agent/src/drivers/acp/types.js';
import type { MessageTransport } from '../packages/agent/src/drivers/codex/ws-unix.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../packages/agent/src/drivers/acp/client.js';
import { JsonlRpcRemoteError } from '../packages/agent/src/drivers/acp/jsonl-rpc.js';
import { codexAcpProfile } from '../packages/agent/src/drivers/acp/profiles.js';
import { codexBridgeLaunch } from '../packages/agent/src/drivers/codex/launch.js';
import { codexSessionsPath, codexSharedSocket, readCodexSessions } from '../packages/agent/src/drivers/codex/shared.js';
import { connectUnixWebSocket } from '../packages/agent/src/drivers/codex/ws-unix.js';

/**
 * The real bridge (source entry, same launch the agent uses) driven by Lifeline's real AcpClient,
 * with `codex app-server` replaced by a fixture that never calls a model. HOME is a temp dir, so the
 * shared socket and the session map live there.
 */
const fixture = fileURLToPath(new URL('./fixtures/mock-codex-app-server.mjs', import.meta.url));
const dirs: string[] = [];

function killShared(home: string): void {
  const sock = codexSharedSocket({}, home);
  const pidFile = `${sock}.pid`;
  if (sock && existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM');
    }
    catch {}
  }
}

after(() => {
  for (const dir of dirs) {
    killShared(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function setup(opts: { env?: Record<string, string>; dir?: string; shared?: boolean } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'lifeline-codex-bridge-'));
  if (!opts.dir)
    dirs.push(dir);
  const codex = join(dir, 'codex');
  writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(codex, 0o755);
  const tracePath = join(dir, 'trace.jsonl');
  const events: AcpClientEvent[] = [];
  const permissions: AcpPermissionEvent[] = [];
  let onPermission: ((event: AcpPermissionEvent) => void) | undefined;
  const launch = codexBridgeLaunch();
  const client = new AcpClient({
    profile: codexAcpProfile,
    command: launch.command,
    args: launch.args,
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      INVOCATION_ID: '',
      LIFELINE_CODEX_CLI: codex,
      MOCK_CODEX_TRACE: tracePath,
      MOCK_CODEX_STATE: join(dir, 'threads.json'),
      ...(opts.shared ? {} : { LIFELINE_CODEX_SHARED: '0' }),
      ...opts.env,
    },
    killGraceMs: 500,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'permission') {
        permissions.push(event);
        onPermission?.(event);
      }
    },
  });
  const updates = () => events.filter(e => e.type === 'update').map(e => (e as { update: Record<string, unknown> }).update);
  const text = (kind: string) => updates()
    .filter(u => u.sessionUpdate === kind)
    .map(u => (u.content as { text?: string } | undefined)?.text ?? '')
    .join('');
  const traced = () => readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  return {
    dir,
    client,
    events,
    permissions,
    updates,
    text,
    traced,
    setOnPermission: (fn: (event: AcpPermissionEvent) => void) => {
      onPermission = fn;
    },
  };
}

/** A second client on the shared server, as `codex --remote` in a terminal would be. */
async function terminal(home: string) {
  const sock = codexSharedSocket({}, home)!;
  const ws: MessageTransport = await connectUnixWebSocket(sock);
  let id = 1;
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  const notes: Array<{ method: string; params: Record<string, unknown> }> = [];
  const requests: Array<{ id: unknown; method: string; params: Record<string, unknown> }> = [];
  ws.onMessage((raw) => {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (msg.method && msg.id != null)
      requests.push(msg as { id: unknown; method: string; params: Record<string, unknown> });
    else if (msg.method)
      notes.push(msg as { method: string; params: Record<string, unknown> });
    else
      waiters.get(msg.id as number)?.(msg);
  });
  const call = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve) => {
    const n = id++;
    waiters.set(n, resolve);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
  });
  await call('initialize', { clientInfo: { name: 'terminal', title: null, version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  const completed = () => notes.filter(n => n.method === 'turn/completed').length;
  return {
    call,
    notes,
    requests,
    completed,
    answer: (reqId: unknown, result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, result })),
    async turn(threadId: string, prompt: string) {
      await call('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
    },
    close: () => ws.close(),
  };
}

describe('codex ACP bridge (private app-server)', () => {
  it('reports models and effort dials on session/new without creating a thread', async () => {
    const t = setup();
    try {
      await t.client.start();
      const init = await t.client.initialize();
      assert.equal(init.protocolVersion, 1);
      const created = await t.client.sessionNew({ cwd: t.dir });
      assert.match(created.sessionId, /^[0-9a-f-]{36}$/);
      assert.equal(created.modelConfigId, 'model');
      assert.equal(created.thinkingConfigId, 'thought_level');
      assert.equal(created.cursorParameters, undefined);
      assert.equal(created.catalog?.currentModelId, 'gpt-test');
      assert.deepEqual(created.catalog?.models.map(m => m.id), ['gpt-test', 'mini-test']);
      const gpt = created.catalog?.models.find(m => m.id === 'gpt-test');
      assert.deepEqual(gpt?.thinking?.levels.map(l => l.value), ['low', 'medium', 'high']);
      assert.equal(created.catalog?.thinking?.current, 'medium');
      // A catalog read or an unused session leaves nothing behind in `codex resume`.
      assert.equal(t.traced().some(entry => entry.method === 'thread/start'), false);
    }
    finally {
      await t.client.close();
    }
  });

  it('starts the thread on the first prompt, records it, and passes model and effort to turn/start', async () => {
    const t = setup();
    try {
      await t.client.start();
      await t.client.initialize();
      const created = await t.client.sessionNew({ cwd: t.dir });
      await t.client.setConfigOption('model', 'mini-test');
      await t.client.setConfigOption('thought_level', 'low');
      const result = await t.client.prompt('ping');
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(t.text('agent_message_chunk'), 'pong');
      assert.equal(t.text('agent_thought_chunk'), 'thinking…');
      const start = t.traced().find(entry => entry.method === 'turn/start');
      assert.equal(start?.params.threadId, 'thread-1');
      assert.equal(start?.params.model, 'mini-test');
      assert.equal(start?.params.effort, 'low');
      assert.deepEqual(start?.params.input, [{ type: 'text', text: 'ping', text_elements: [] }]);
      assert.equal(readCodexSessions(codexSessionsPath(t.dir))[created.sessionId]?.threadId, 'thread-1');
    }
    finally {
      await t.client.close();
    }
  });

  it('turns a command approval into an ACP permission and shows the outcome on one tool row', async () => {
    const t = setup();
    try {
      t.setOnPermission(event => void event.respond({ outcome: 'selected', optionId: 'accept' }));
      await t.client.start();
      await t.client.initialize();
      await t.client.sessionNew({ cwd: t.dir });
      const result = await t.client.prompt('please run it');
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(t.permissions.length, 1);
      const approval = codexAcpProfile.toCliApproval(t.permissions[0]!.raw, 'a1', 's1');
      assert.equal(approval.title, '运行命令: echo hi > out.txt');
      assert.deepEqual(approval.options.map(o => [o.optionId, o.kind]), [
        ['accept', 'allow_once'],
        ['acceptForSession', 'allow_always'],
        ['decline', 'reject_once'],
      ]);
      const tools = t.updates().filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
      assert.equal(tools[0]?.title, '▸ $ echo hi > out.txt');
      assert.equal(tools.at(-1)?.status, 'completed');
      assert.equal(tools.at(-1)?.title, '✓ $ echo hi > out.txt');
    }
    finally {
      await t.client.close();
    }
  });

  it('declined command ends as a cancelled row', async () => {
    const t = setup();
    try {
      t.setOnPermission(event => void event.respond({ outcome: 'selected', optionId: 'decline' }));
      await t.client.start();
      await t.client.initialize();
      await t.client.sessionNew({ cwd: t.dir });
      await t.client.prompt('run but no');
      const last = t.updates().filter(u => u.sessionUpdate === 'tool_call_update').at(-1);
      assert.equal(last?.status, 'cancelled');
      assert.equal(last?.title, '⊘ $ echo hi > out.txt');
    }
    finally {
      await t.client.close();
    }
  });

  it('session/cancel interrupts the running turn', async () => {
    const t = setup();
    try {
      await t.client.start();
      await t.client.initialize();
      await t.client.sessionNew({ cwd: t.dir });
      const pending = t.client.prompt('slow please');
      await until(() => t.traced().some(entry => entry.method === 'turn/start'), 'turn/start');
      await sleep(100);
      await t.client.cancel();
      const result = await pending;
      assert.equal(result.stopReason, 'cancelled');
      assert.equal(t.traced().some(entry => entry.method === 'turn/interrupt'), true);
    }
    finally {
      await t.client.close();
    }
  });

  it('session/load in a new process follows the recorded thread and replays recent turns compactly', async () => {
    const first = setup();
    let sessionId: string;
    try {
      await first.client.start();
      await first.client.initialize();
      sessionId = (await first.client.sessionNew({ cwd: first.dir })).sessionId;
      await first.client.prompt('first question');
    }
    finally {
      await first.client.close();
    }
    const t = setup({ dir: first.dir });
    try {
      await t.client.start();
      await t.client.initialize();
      const loaded = await t.client.sessionLoad({ cwd: t.dir, sessionId });
      assert.equal(loaded.sessionId, sessionId);
      assert.equal(loaded.catalog?.currentModelId, 'mini-test');
      assert.equal(t.text('user_message_chunk'), 'first question');
      assert.equal(t.text('agent_message_chunk'), 'pong');
      const resume = t.traced().filter(entry => entry.method === 'thread/resume').at(-1);
      assert.equal(resume?.params.threadId, 'thread-1');
      assert.equal(resume?.params.excludeTurns, true);
      assert.equal((await t.client.prompt('again')).stopReason, 'end_turn');
    }
    finally {
      await t.client.close();
    }
  });

  it('a session that never ran a prompt cannot be loaded', async () => {
    const t = setup();
    try {
      await t.client.start();
      await t.client.initialize();
      await assert.rejects(t.client.sessionLoad({ cwd: t.dir, sessionId: '00000000-0000-4000-8000-000000000000' }));
    }
    finally {
      await t.client.close();
    }
  });

  it('a signed-out codex fails session/new with 401 (credential-required)', async () => {
    const t = setup({ env: { MOCK_CODEX_SIGNED_OUT: '1' } });
    try {
      await t.client.start();
      await t.client.initialize();
      await assert.rejects(t.client.sessionNew({ cwd: t.dir }), (err: unknown) => {
        assert.ok(err instanceof JsonlRpcRemoteError);
        assert.equal(err.rpcCode, 401);
        return true;
      });
    }
    finally {
      await t.client.close();
    }
  });

  it('/attach explains that terminal sessions need the shared server', async () => {
    const t = setup();
    try {
      await t.client.start();
      await t.client.initialize();
      await t.client.sessionNew({ cwd: t.dir });
      assert.equal((await t.client.prompt('/attach')).stopReason, 'end_turn');
      assert.match(t.text('agent_message_chunk'), /共享 Codex 服务不可用/);
    }
    finally {
      await t.client.close();
    }
  });
});

describe('codex ACP bridge (shared app-server)', () => {
  it('starts the shared server on demand and leaves it running after the session closes', async () => {
    const t = setup({ shared: true });
    try {
      await t.client.start();
      await t.client.initialize();
      await t.client.sessionNew({ cwd: t.dir });
      assert.equal((await t.client.prompt('ping')).stopReason, 'end_turn');
      assert.equal(t.text('agent_message_chunk'), 'pong');
    }
    finally {
      await t.client.close();
    }
    const term = await terminal(t.dir);
    const loaded = await term.call('thread/list', { cwd: t.dir });
    assert.equal(((loaded.result as { data: unknown[] }).data).length, 1);
    term.close();
  });

  it('follows a terminal thread after /attach: its turns, tool rows and approvals reach the web', async () => {
    const t = setup({ shared: true });
    // Bring the shared server up through the bridge, then open a "terminal" thread on it.
    await t.client.start();
    await t.client.initialize();
    await t.client.sessionNew({ cwd: t.dir });
    const term = await terminal(t.dir);
    try {
      const started = await term.call('thread/start', { cwd: t.dir });
      const threadId = ((started.result as { thread: { id: string } }).thread).id;
      await term.turn(threadId, 'terminal first');
      await until(() => term.completed() === 1, 'first terminal turn');

      assert.equal((await t.client.prompt('/attach list')).stopReason, 'end_turn');
      assert.match(t.text('agent_message_chunk'), new RegExp(`1\\. .*terminal first[\\s\\S]*${threadId}`));
      assert.equal((await t.client.prompt('/attach 1')).stopReason, 'end_turn');
      assert.match(t.text('agent_message_chunk'), new RegExp(`已接管 ${threadId}`));
      assert.match(t.text('agent_message_chunk'), /▶ terminal first/);

      t.setOnPermission(event => void event.respond({ outcome: 'selected', optionId: 'accept' }));
      await term.turn(threadId, 'please run it');
      await until(() => term.completed() === 2, 'approved terminal turn');
      // Both clients got the approval; the web answered, so the terminal hears it was resolved.
      assert.equal(t.permissions.length, 1);
      assert.equal(term.requests.length, 1);
      assert.equal(term.notes.some(n => n.method === 'serverRequest/resolved'), true);
      await until(() => t.text('agent_message_chunk').includes('■ 终端回合结束（完成）'), 'turn end note');
      const text = t.text('agent_message_chunk');
      assert.match(text, /▶ 终端：please run it/);
      const tools = t.updates().filter(u => String(u.sessionUpdate).startsWith('tool_call'));
      assert.equal(tools.at(-1)?.title, '✓ $ echo hi > out.txt');
    }
    finally {
      term.close();
      await t.client.close();
    }
  });

  it('an approval answered in the terminal first is not answered again from the web', async () => {
    const t = setup({ shared: true });
    await t.client.start();
    await t.client.initialize();
    const created = await t.client.sessionNew({ cwd: t.dir });
    assert.equal((await t.client.prompt('ping')).stopReason, 'end_turn');
    const threadId = readCodexSessions(codexSessionsPath(t.dir))[created.sessionId]!.threadId;
    const term = await terminal(t.dir);
    try {
      await term.call('thread/resume', { threadId });
      await term.turn(threadId, 'run from terminal');
      await until(() => term.requests.length === 1 && t.permissions.length === 1, 'approval on both sides');
      term.answer(term.requests[0]!.id, { decision: 'accept' });
      await until(() => t.text('agent_message_chunk').includes('已在终端处理'), 'resolved note');
      // The web card is answered late; the bridge must not send a second answer.
      void t.permissions[0]!.respond({ outcome: 'selected', optionId: 'decline' });
      await until(() => term.completed() === 1, 'terminal turn end');
      const last = t.updates().filter(u => u.sessionUpdate === 'tool_call_update').at(-1);
      assert.equal(last?.status, 'completed');
    }
    finally {
      term.close();
      await t.client.close();
    }
  });

  it('a web message sent during a terminal turn waits for it', async () => {
    const t = setup({ shared: true });
    await t.client.start();
    await t.client.initialize();
    const created = await t.client.sessionNew({ cwd: t.dir });
    assert.equal((await t.client.prompt('ping')).stopReason, 'end_turn');
    const threadId = readCodexSessions(codexSessionsPath(t.dir))[created.sessionId]!.threadId;
    const term = await terminal(t.dir);
    try {
      await term.call('thread/resume', { threadId });
      await term.turn(threadId, 'wait for me');
      await until(() => t.text('agent_message_chunk').includes('▶ 终端：wait for me'), 'terminal turn visible');
      const queued = t.client.prompt('after you');
      await until(() => t.text('agent_message_chunk').includes('等它结束'), 'queued note');
      const starts = () => t.traced().filter(entry => entry.method === 'turn/start').length;
      assert.equal(starts(), 2);
      await term.call('mock/release', {});
      assert.equal((await queued).stopReason, 'end_turn');
      assert.equal(starts(), 3);
      const text = t.text('agent_message_chunk');
      assert.ok(text.indexOf('■ 终端回合结束') < text.lastIndexOf('pong'));
    }
    finally {
      term.close();
      await t.client.close();
    }
  });

  it('closing the web session leaves a pending shared approval to the terminal', async () => {
    const t = setup({ shared: true });
    await t.client.start();
    await t.client.initialize();
    const created = await t.client.sessionNew({ cwd: t.dir });
    assert.equal((await t.client.prompt('ping')).stopReason, 'end_turn');
    const threadId = readCodexSessions(codexSessionsPath(t.dir))[created.sessionId]!.threadId;
    const term = await terminal(t.dir);
    try {
      await term.call('thread/resume', { threadId });
      await term.turn(threadId, 'run it later');
      await until(() => t.permissions.length === 1, 'web approval card');
      await t.client.close();
      await sleep(1500);
      // No `cancel` came from the web: the terminal still decides.
      assert.equal(term.completed(), 0);
      term.answer(term.requests[0]!.id, { decision: 'accept' });
      await until(() => term.completed() === 1, 'terminal decided');
      const done = term.notes.filter(n => n.method === 'item/completed').map(n => n.params.item as { type: string; status?: string });
      assert.equal(done.find(item => item.type === 'commandExecution')?.status, 'completed');
    }
    finally {
      term.close();
    }
  });

  it('after an agent restart the attached session reloads the terminal thread', async () => {
    const first = setup({ shared: true });
    await first.client.start();
    await first.client.initialize();
    const created = await first.client.sessionNew({ cwd: first.dir });
    const term = await terminal(first.dir);
    let threadId = '';
    try {
      const started = await term.call('thread/start', { cwd: first.dir });
      threadId = ((started.result as { thread: { id: string } }).thread).id;
      await term.turn(threadId, 'from the terminal');
      await until(() => term.completed() === 1, 'terminal turn');
      await first.client.prompt(`/attach ${threadId}`);
    }
    finally {
      term.close();
      await first.client.close();
    }
    assert.equal(readCodexSessions(codexSessionsPath(first.dir))[created.sessionId]?.threadId, threadId);
    const t = setup({ dir: first.dir, shared: true });
    try {
      await t.client.start();
      await t.client.initialize();
      await t.client.sessionLoad({ cwd: t.dir, sessionId: created.sessionId });
      assert.equal(t.text('user_message_chunk'), 'from the terminal');
      assert.equal((await t.client.prompt('continue here')).stopReason, 'end_turn');
      const start = t.traced().filter(entry => entry.method === 'turn/start').at(-1);
      assert.equal(start?.params.threadId, threadId);
    }
    finally {
      await t.client.close();
    }
  });
});
