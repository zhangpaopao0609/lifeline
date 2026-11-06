import type { AcpClientEvent, AcpPermissionEvent } from '../packages/agent/src/drivers/acp/types.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandPayloadSchema } from '@lifeline/protocol';
import { buildLiveAcpClientOptions, createLiveCliEntry, openLiveAcpClient } from '../packages/agent/src/drivers/acp/live-entry.js';
import { codexCliProfile } from '../packages/agent/src/drivers/acp/profiles.js';
import { cliResumeCommand, readCliSessionLedger } from '../packages/agent/src/drivers/acp/session-ledger.js';
import { CodexClient } from '../packages/agent/src/drivers/codex/client.js';
import { codexItemUpdate } from '../packages/agent/src/drivers/codex/updates.js';
import { agentRuntimeEnv } from '../packages/cli/src/commands/start.js';
import { lookupCliProvider, readCliConfigFile, withPersistedCliProviders, writeCliConfigFile } from '../packages/cli/src/config.js';
import { planLaunchdProviderSpawn } from '../packages/cli/src/daemon/launchd.js';
import { cliAgentLabel } from '../packages/web/src/store/cli.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-codex-agent.mjs', import.meta.url));
const epoch = '11111111-1111-4111-8111-111111111111';
const config = { serverUrl: 'https://lifeline.example', agentToken: 'local-token', cdpUrl: 'http://127.0.0.1:9222', pollIntervalMs: 500, debounceMs: 300 };

function frames(trace: string): any[] {
  try { return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = read();
    if (found !== undefined)
      return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Codex fixture did not reach expected state');
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lifeline-codex-test-')));
  const trace = join(dir, 'trace.jsonl');
  const events: AcpClientEvent[] = [];
  const client = new CodexClient({ profile: codexCliProfile, command: process.execPath, args: [fixture, trace], cwd: dir, env: { ...process.env, ...env }, killGraceMs: 5, onEvent: event => events.push(event) });
  return { dir, trace, events, client, cleanup: async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('Codex CLI native app-server', () => {
  it('discovers a persisted absolute path, advertises Codex, and strips unrelated credentials', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lifeline-codex-config-')));
    try {
      const binary = join(dir, 'codex');
      writeFileSync(binary, '#!/bin/sh\nexit 0\n'); chmodSync(binary, 0o755);
      assert.equal(lookupCliProvider('codex-cli', { PATH: dir }), binary);
      const saved = withPersistedCliProviders({ config, lookup: source => source === 'codex-cli' ? binary : undefined });
      const path = join(dir, 'config.json'); writeCliConfigFile(saved, path);
      assert.equal(readCliConfigFile(path)?.codexCliPath, binary);
      assert.equal(withPersistedCliProviders({ config, existing: saved }).codexCliPath, binary);
      assert.throws(() => writeCliConfigFile({ ...config, codexCliPath: './codex' }, path), /absolute/);
      const env = agentRuntimeEnv(saved, { HOME: dir, PATH: '/usr/bin:/bin', AGENT_TOKEN: 'secret', REMOTE_URL: 'secret', CODEBUDDY_API_KEY: 'cb-secret', DEEPSEEK_API_KEY: 'ds-secret', OPENAI_API_KEY: 'local-openai-key' });
      assert.equal(env.LIFELINE_CODEX_CLI, binary);
      const options = buildLiveAcpClientOptions({ source: 'codex-cli', cwd: dir, env });
      assert.deepEqual(options.args, ['app-server', '--listen', 'stdio://']);
      for (const key of ['AGENT_TOKEN', 'REMOTE_URL', 'CODEBUDDY_API_KEY', 'DEEPSEEK_API_KEY']) assert.equal(options.env?.[key], undefined);
      assert.equal(options.env?.OPENAI_API_KEY, 'local-openai-key');
      assert.equal(options.env?.HOME, dir);
      assert.deepEqual(planLaunchdProviderSpawn({ source: 'codex-cli', command: binary, baseEnv: env }).args, options.args);
      assert.equal(cliAgentLabel('codex-cli'), 'Codex');
      assert.equal(commandPayloadSchema.safeParse({ commandId: epoch, source: 'codex-cli', cwd: dir }).success, true);
      assert.throws(() => openLiveAcpClient({ source: 'codex-cli', cwd: dir, env, platform: 'win32' }), /unsupported-platform/);
      let linuxConstructions = 0;
      openLiveAcpClient({ source: 'codex-cli', cwd: dir, env, platform: 'linux' }, () => {
        linuxConstructions += 1;
        return undefined as never;
      });
      assert.equal(linuxConstructions, 1);
      assert.match(cliResumeCommand({ source: 'codex-cli', cwd: dir, providerSessionId: 'codex-thread', modelId: 'model-a', thinking: 'high' })!, /codex resume 'codex-thread'.*model_reasoning_effort/);
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses native frames, model pagination and turn completion without duplicate text or foreign events', async () => {
    const f = setup();
    try {
      await f.client.start(); await f.client.initialize();
      const created = await f.client.sessionNew({ cwd: f.dir });
      assert.deepEqual(created.catalog?.models.map(model => model.id), ['model-a', 'model-b']);
      await f.client.setConfigOption('model', 'model-b');
      await f.client.setConfigOption('effort', 'high');
      await assert.rejects(f.client.setConfigOption('effort', 'max'), /Unsupported/);
      assert.deepEqual(await f.client.prompt('Hello'), { stopReason: 'end_turn' });
      const turn = frames(f.trace).find(frame => frame.method === 'turn/start');
      assert.equal(turn.params.model, 'model-b'); assert.equal(turn.params.effort, 'high');
      assert.equal(frames(f.trace).some(frame => 'jsonrpc' in frame), false);
      const updates = f.events.flatMap(event => event.type === 'update' ? [event.update as any] : []);
      assert.equal(updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text).join(''), 'Hello Codex');
      assert.ok(updates.some(update => update.sessionUpdate === 'plan'));
      assert.equal(JSON.stringify(f.events).includes('codex-provider-thread'), false);
      assert.equal(JSON.stringify(f.events).includes('must not leak'), false);
    }
    finally { await f.cleanup(); }
  });

  for (const prompt of ['__APPROVAL__', '__FILE__', '__NETWORK__']) {
    for (const decision of ['accept', 'decline', 'cancel']) {
      it(`routes ${prompt} ${decision} as a one-shot decision`, async () => {
        const f = setup();
        try {
          await f.client.start(); await f.client.initialize(); await f.client.sessionNew({ cwd: f.dir });
          const pending = f.client.prompt(prompt);
          const permission = await until(() => f.events.find((event): event is AcpPermissionEvent => event.type === 'permission'));
          const raw = permission.raw as any;
          assert.deepEqual(raw.options.map((option: any) => option.optionId), ['accept', 'decline']);
          if (prompt === '__NETWORK__')
            assert.match(raw.toolCall.title, /Network access: https example.com/);
          if (prompt === '__FILE__')
            assert.match(raw.toolCall.title, /\/work\/marker\.txt/);
          assert.deepEqual(await permission.respond({ outcome: 'selected', optionId: 'acceptForSession' }), { ok: false, state: 'unsupported-permission-option' });
          assert.deepEqual(await permission.respond(decision === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: decision }), { ok: true });
          await pending; await f.client.close();
          assert.deepEqual(frames(f.trace).find(frame => frame.id === 'approval')?.result, { decision });
          assert.equal(frames(f.trace).at(-1)?.method, 'thread/unsubscribe');
          assert.equal(frames(f.trace).some(frame => frame.method === 'thread/archive'), false);
        }
        finally { await f.cleanup(); }
      });
    }
  }

  it('keeps completion-only replies exactly once and ignores late duplicate deltas', async () => {
    const f = setup();
    try {
      await f.client.start(); await f.client.initialize(); await f.client.sessionNew({ cwd: f.dir });
      await f.client.prompt('__COMPLETED_ONLY__');
      const texts = f.events.flatMap(event => event.type === 'update' ? [(event.update as any).content?.text] : []).filter(Boolean);
      assert.deepEqual(texts, ['Completed without deltas']);
    }
    finally { await f.cleanup(); }
  });

  it('does not offer approval when the operation preview would be truncated', async () => {
    const f = setup();
    try {
      await f.client.start(); await f.client.initialize(); await f.client.sessionNew({ cwd: f.dir });
      const pending = f.client.prompt('__LARGE__');
      const permission = await until(() => f.events.find((event): event is AcpPermissionEvent => event.type === 'permission'));
      assert.deepEqual((permission.raw as any).options.map((option: any) => option.optionId), ['decline']);
      await permission.respond({ outcome: 'selected', optionId: 'decline' });
      await pending;
    }
    finally { await f.cleanup(); }
  });

  it('cancels an outstanding approval on close and never accepts a late response', async () => {
    const f = setup();
    try {
      await f.client.start(); await f.client.initialize(); await f.client.sessionNew({ cwd: f.dir });
      const pending = f.client.prompt('__APPROVAL__');
      void pending.catch(() => {});
      const permission = await until(() => f.events.find((event): event is AcpPermissionEvent => event.type === 'permission'));
      await f.client.close();
      await pending.catch(() => {});
      assert.deepEqual(frames(f.trace).filter(frame => frame.id === 'approval').map(frame => frame.result), [{ decision: 'cancel' }]);
      await assert.rejects(permission.respond({ outcome: 'selected', optionId: 'accept' }), /resolved/);
    }
    finally { await f.cleanup(); }
  });

  it('projects public reasoning summaries and MCP output', () => {
    const thought = codexItemUpdate({ id: 'r', type: 'reasoning', summary: ['Public summary'], content: ['Not for the timeline'] }, false, true) as any;
    assert.equal(thought.content.text, 'Public summary');
    const tool = codexItemUpdate({ id: 'm', type: 'mcpToolCall', server: 'local', tool: 'lookup', status: 'completed', result: { content: [{ type: 'text', text: 'MCP result' }] } }, false, true) as any;
    assert.equal(tool.title, 'local: lookup');
    assert.equal(tool.content[0].content.text, 'MCP result');
  });

  for (const paginated of [false, true]) {
    it(`replays ${paginated ? 'paginated' : 'legacy'} history in chronological order`, async () => {
      const f = setup(paginated ? { CODEX_FIXTURE_PAGINATED: '1' } : {});
      try {
        await f.client.start(); await f.client.initialize();
        await f.client.sessionLoad({ cwd: f.dir, sessionId: 'codex-provider-thread' });
        const chunks = f.events.flatMap(event => event.type === 'update' ? [(event.update as any).content?.text] : []).filter(Boolean);
        assert.deepEqual(chunks, ['Earlier question', 'Earlier answer']);
        const resumes = frames(f.trace).filter(frame => frame.method === 'thread/resume');
        assert.equal(resumes.length, 1);
        assert.equal(resumes[0]?.params.excludeTurns, true);
        assert.equal(frames(f.trace).filter(frame => frame.method === 'thread/items/list').length, 2);
      }
      finally { await f.cleanup(); }
    });
  }

  it('interrupts before turn/start resolves and handles failed turns, unsupported tools, and process death', async () => {
    const f = setup();
    try {
      await f.client.start(); await f.client.initialize(); await f.client.sessionNew({ cwd: f.dir });
      const pending = f.client.prompt('__EARLY_STOP__');
      await f.client.cancel();
      assert.deepEqual(await pending, { stopReason: 'cancelled' });
      await assert.rejects(f.client.prompt('__FAIL__'), /failed/);
      await assert.rejects(f.client.prompt('__UNSUPPORTED__'), (err: unknown) => {
        assert.equal(err instanceof Error && err.message, 'unsupported-request');
        assert.equal(String(err).includes('private provider'), false);
        return true;
      });
      assert.equal(frames(f.trace).find(frame => frame.id === 'unsupported')?.error?.code, -32601);
      await assert.rejects(f.client.prompt('__CRASH__'), /process exited/);
    }
    finally { await f.cleanup(); }
  });

  it('replays legacy history from a full resume when item pages are unavailable', async () => {
    const f = setup({ CODEX_FIXTURE_NO_ITEMS: '1' });
    try {
      await f.client.start(); await f.client.initialize();
      await f.client.sessionLoad({ cwd: f.dir, sessionId: 'codex-provider-thread' });
      const chunks = f.events.flatMap(event => event.type === 'update' ? [(event.update as any).content?.text] : []).filter(Boolean);
      assert.deepEqual(chunks, ['Earlier question', 'Earlier answer']);
      const resumes = frames(f.trace).filter(frame => frame.method === 'thread/resume');
      assert.equal(resumes.length, 2);
      assert.equal(resumes[0]?.params.excludeTurns, true);
      assert.equal(resumes[1]?.params.excludeTurns, undefined);
      assert.equal(frames(f.trace).some(frame => frame.method === 'thread/archive' || frame.method === 'thread/delete'), false);
    }
    finally { await f.cleanup(); }
  });

  it('classifies missing Codex login before creating a session', async () => {
    const f = setup({ CODEX_FIXTURE_NO_AUTH: '1' });
    try { await f.client.start(); await assert.rejects(f.client.initialize(), /login required/); }
    finally { await f.cleanup(); }
  });

  it('reads the model catalog without starting a Codex thread', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lifeline-codex-catalog-')));
    const trace = join(dir, 'trace.jsonl');
    const entry = createLiveCliEntry({
      epoch,
      platform: 'darwin' as const,
      env: { ...process.env, LIFELINE_CODEX_CLI: '/opt/bin/codex' },
      emit: () => {},
      construct: (input: ConstructorParameters<typeof CodexClient>[0]) => new CodexClient({ ...input, command: process.execPath, args: [fixture, trace], killGraceMs: 5 }),
    });
    try {
      const result = await entry.manager.readCatalog({ source: 'codex-cli', cwd: dir });
      assert.equal(result.ok, true);
      if (!result.ok)
        return;
      assert.deepEqual(result.data.catalog?.models.map(model => model.id), ['model-a', 'model-b']);
      assert.equal(result.data.catalog?.currentModelId, 'model-b');
      assert.deepEqual(result.data.catalog?.models[0]?.thinking?.levels.map(level => level.value), ['medium', 'high']);
      const methods = frames(trace).map(frame => frame.method);
      assert.equal(methods.includes('model/list'), true);
      assert.equal(methods.includes('thread/start'), false);
      assert.equal(methods.includes('thread/archive'), false);
      assert.equal(methods.includes('thread/delete'), false);
    }
    finally { await entry.manager.closeAll(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses the production session manager for selection, errors, retry, and restart recovery', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lifeline-codex-manager-')));
    const trace = join(dir, 'trace.jsonl');
    const ledger = join(dir, 'sessions.json');
    const events: Array<{ event: string; payload: any }> = [];
    const options = {
      epoch,
      platform: 'darwin' as const,
      ledgerPath: ledger,
      env: { ...process.env, LIFELINE_CODEX_CLI: '/opt/bin/codex' },
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
      construct: (input: ConstructorParameters<typeof CodexClient>[0]) => new CodexClient({ ...input, command: process.execPath, args: [fixture, trace], killGraceMs: 5 }),
    };
    const entry = createLiveCliEntry(options);
    let restored: ReturnType<typeof createLiveCliEntry> | undefined;
    const status = () => events.filter(item => item.event === 'cli:status').at(-1)?.payload;
    try {
      const started = await entry.start({ source: 'codex-cli', cwd: dir, modelId: 'model-b', thinking: 'high' });
      assert.equal(started.ok, true); if (!started.ok)
        return;
      const target = { source: 'codex-cli' as const, sessionId: started.data.sessionId };
      assert.equal(status().catalog.currentModelId, 'model-b'); assert.equal(status().catalog.thinking.current, 'high');
      assert.deepEqual(await entry.manager.selectModel({ ...target, modelId: 'model-a' }), { ok: true });
      assert.deepEqual(status().catalog.thinking.levels.map((level: any) => level.value), ['medium', 'high']);
      assert.equal(status().catalog.thinking.current, 'medium');
      assert.deepEqual(await entry.manager.selectThinking({ ...target, thinking: 'high' }), { ok: true });
      assert.equal(readCliSessionLedger(ledger)[0]?.thinking, 'high');
      entry.manager.prompt({ ...target, text: '__FAIL__', clientMessageId: 'fail' });
      await until(() => status()?.error ? true : undefined);
      assert.equal(status().error, 'Codex 请求失败，请重试。');
      assert.equal(JSON.stringify(events).includes('private provider failure detail'), false);
      entry.manager.prompt({ ...target, text: '__UNSUPPORTED__', clientMessageId: 'unsupported' });
      await until(() => typeof status()?.error === 'string' && status().error.includes('无法在 Lifeline') ? true : undefined);
      assert.equal(status().error, '该请求无法在 Lifeline 里完成。');
      assert.equal(JSON.stringify(events).includes('private provider failure detail'), false);
      entry.manager.prompt({ ...target, text: 'Retry', clientMessageId: 'retry' });
      await until(() => status()?.status === 'idle' ? true : undefined);
      assert.equal(status().error, undefined);
      await entry.manager.closeAll();
      restored = createLiveCliEntry({ ...options, epoch: '22222222-2222-4222-8222-222222222222' });
      await restored.manager.restore();
      assert.equal(status().catalog.thinking.current, 'high');
      assert.equal(status().status, 'idle');
      assert.ok(events.some(item => item.event === 'cli:full' && item.payload.messages.some((message: any) => message.text === 'Earlier answer')));
    }
    finally { await entry.manager.closeAll(); await restored?.manager.closeAll(); rmSync(dir, { recursive: true, force: true }); }
  });
});
