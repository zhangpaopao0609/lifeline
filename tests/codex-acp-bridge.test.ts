import type { AcpClientEvent, AcpPermissionEvent } from '../packages/agent/src/drivers/acp/types.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../packages/agent/src/drivers/acp/client.js';
import { JsonlRpcRemoteError } from '../packages/agent/src/drivers/acp/jsonl-rpc.js';
import { codexAcpProfile } from '../packages/agent/src/drivers/acp/profiles.js';
import { codexBridgeLaunch } from '../packages/agent/src/drivers/codex/launch.js';

/**
 * The real bridge (source entry, same launch the agent uses) driven by Lifeline's real AcpClient,
 * with `codex app-server` replaced by a fixture that never calls a model.
 */
const fixture = fileURLToPath(new URL('./fixtures/mock-codex-app-server.mjs', import.meta.url));
const dirs: string[] = [];

after(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true });
});

function setup(env: Record<string, string> = {}, reuseDir?: string) {
  const dir = reuseDir ?? mkdtempSync(join(tmpdir(), 'lifeline-codex-bridge-'));
  if (!reuseDir)
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
    env: { ...process.env, LIFELINE_CODEX_CLI: codex, MOCK_CODEX_TRACE: tracePath, MOCK_CODEX_STATE: join(dir, 'threads.json'), ...env },
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

describe('codex ACP bridge', () => {
  it('reports models and effort dials on session/new, keyed by the codex thread id', async () => {
    const t = setup();
    try {
      await t.client.start();
      const init = await t.client.initialize();
      assert.equal(init.protocolVersion, 1);
      const created = await t.client.sessionNew({ cwd: t.dir });
      assert.equal(created.sessionId, 'thread-1');
      assert.equal(created.modelConfigId, 'model');
      assert.equal(created.thinkingConfigId, 'thought_level');
      assert.equal(created.cursorParameters, undefined);
      assert.equal(created.catalog?.currentModelId, 'gpt-test');
      assert.deepEqual(created.catalog?.models.map(m => m.id), ['gpt-test', 'mini-test']);
      const gpt = created.catalog?.models.find(m => m.id === 'gpt-test');
      assert.deepEqual(gpt?.thinking?.levels.map(l => l.value), ['low', 'medium', 'high']);
      assert.equal(created.catalog?.thinking?.current, 'medium');
    }
    finally {
      await t.client.close();
    }
  });

  it('streams a turn and passes the chosen model and effort to turn/start', async () => {
    const t = setup();
    try {
      await t.client.start();
      await t.client.initialize();
      await t.client.sessionNew({ cwd: t.dir });
      await t.client.setConfigOption('model', 'mini-test');
      await t.client.setConfigOption('thought_level', 'low');
      const result = await t.client.prompt('ping');
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(t.text('agent_message_chunk'), 'pong');
      assert.equal(t.text('agent_thought_chunk'), 'thinking…');
      const start = t.traced().find(entry => entry.method === 'turn/start');
      assert.equal(start?.params.model, 'mini-test');
      assert.equal(start?.params.effort, 'low');
      assert.deepEqual(start?.params.input, [{ type: 'text', text: 'ping', text_elements: [] }]);
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
      await new Promise(resolve => setTimeout(resolve, 300));
      await t.client.cancel();
      const result = await pending;
      assert.equal(result.stopReason, 'cancelled');
      assert.equal(t.traced().some(entry => entry.method === 'turn/interrupt'), true);
    }
    finally {
      await t.client.close();
    }
  });

  it('session/load in a new process resumes the thread and replays recent turns compactly', async () => {
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
    const t = setup({}, first.dir);
    try {
      await t.client.start();
      await t.client.initialize();
      const loaded = await t.client.sessionLoad({ cwd: t.dir, sessionId });
      assert.equal(loaded.sessionId, sessionId);
      assert.equal(loaded.catalog?.currentModelId, 'mini-test');
      assert.equal(t.text('user_message_chunk'), 'first question');
      assert.equal(t.text('agent_message_chunk'), 'pong');
      const resume = t.traced().find(entry => entry.method === 'thread/resume');
      assert.equal(resume?.params.excludeTurns, true);
      assert.equal(t.traced().some(entry => entry.method === 'thread/turns/list'), true);
      // The loaded session runs turns on the same thread.
      assert.equal((await t.client.prompt('again')).stopReason, 'end_turn');
    }
    finally {
      await t.client.close();
    }
  });

  it('a thread that never ran a turn cannot be loaded', async () => {
    const t = setup();
    try {
      await t.client.start();
      await t.client.initialize();
      await assert.rejects(t.client.sessionLoad({ cwd: t.dir, sessionId: 'thread-404' }));
    }
    finally {
      await t.client.close();
    }
  });

  it('a signed-out codex fails session/new with 401 (credential-required)', async () => {
    const t = setup({ MOCK_CODEX_SIGNED_OUT: '1' });
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
});
