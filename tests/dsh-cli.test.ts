import type { AcpClientEvent, AcpPermissionEvent } from '../packages/agent/src/drivers/acp/types.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandPayloadSchema } from '@lifeline/protocol';
import { AcpClient } from '../packages/agent/src/drivers/acp/client.js';
import { describeDshToolUpdate } from '../packages/agent/src/drivers/acp/dsh-update.js';
import { buildLiveAcpClientOptions, createLiveCliEntry, openLiveAcpClient } from '../packages/agent/src/drivers/acp/live-entry.js';
import { acpProfileFor, dshAcpProfile } from '../packages/agent/src/drivers/acp/profiles.js';
import { cliResumeCommand, readCliSessionLedger } from '../packages/agent/src/drivers/acp/session-ledger.js';
import { agentRuntimeEnv } from '../packages/cli/src/commands/start.js';
import { lookupCliProvider, readCliConfigFile, withPersistedCliProviders, writeCliConfigFile } from '../packages/cli/src/config.js';
import { planLaunchdProviderSpawn } from '../packages/cli/src/daemon/launchd.js';
import { cliAgentLabel, visibleCliSources } from '../packages/web/src/store/cli.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dsh-agent.mjs', import.meta.url));
const MODEL_A = '["deepseek-official","model-a"]';
const MODEL_B = '["deepseek-official","model-b"]';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const config = { serverUrl: 'https://lifeline.example', agentToken: 'local-token', cdpUrl: 'http://127.0.0.1:9222', pollIntervalMs: 500, debounceMs: 300 };

interface Frame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

function readTrace(path: string): Frame[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  catch {
    return [];
  }
}

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = read();
    if (found !== undefined)
      return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('DSH fixture did not reach the expected state');
}

describe('DeepSeek Harness CLI', () => {
  it('discovers and preserves an absolute dsh path without passing CodeBuddy credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifeline-dsh-config-'));
    try {
      const binary = join(dir, 'dsh');
      writeFileSync(binary, '#!/bin/sh\nexit 0\n');
      chmodSync(binary, 0o755);
      assert.equal(lookupCliProvider('dsh-cli', { PATH: dir }), binary);
      const saved = withPersistedCliProviders({ config, lookup: source => source === 'dsh-cli' ? binary : undefined });
      const path = join(dir, 'config.json');
      writeCliConfigFile(saved, path);
      assert.equal(readCliConfigFile(path)?.dshCliPath, binary);
      assert.equal(withPersistedCliProviders({ config, existing: saved }).dshCliPath, binary);
      assert.throws(() => writeCliConfigFile({ ...config, dshCliPath: './dsh' }, path), /absolute/);
      const env = agentRuntimeEnv(saved, { HOME: dir, PATH: '/usr/bin:/bin', AGENT_TOKEN: 'secret', CODEBUDDY_API_KEY: 'cb-secret' });
      assert.equal(env.LIFELINE_DSH_CLI, binary);
      const options = buildLiveAcpClientOptions({ source: 'dsh-cli', cwd: dir, env, apiKey: 'cb-secret' });
      assert.equal(options.profile, acpProfileFor('dsh-cli'));
      assert.deepEqual(options.args, ['--profile', 'acp']);
      assert.equal(options.env?.AGENT_TOKEN, undefined);
      assert.equal(options.env?.REMOTE_URL, undefined);
      assert.equal(options.env?.CODEBUDDY_API_KEY, undefined);
      assert.equal(options.env?.HOME, dir);
      assert.ok(options.env?.PATH?.startsWith(dir));
      assert.deepEqual(planLaunchdProviderSpawn({ source: 'dsh-cli', command: binary, baseEnv: env }).args, ['--profile', 'acp']);
      assert.equal(agentRuntimeEnv(config, { LIFELINE_DSH_CLI: binary }).LIFELINE_DSH_CLI, undefined);
      assert.throws(() => openLiveAcpClient({ source: 'dsh-cli', cwd: dir, env, platform: 'linux' }), /unsupported-platform/);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('offers DSH on the web and accepts its wire source without inventing a terminal resume command', () => {
    assert.equal(cliAgentLabel('dsh-cli'), 'DeepSeek Harness');
    assert.deepEqual(visibleCliSources({ platform: 'darwin', cliSources: [{ source: 'dsh-cli', availability: 'unknown' }] }), [{ source: 'dsh-cli', availability: 'unknown' }]);
    assert.equal(commandPayloadSchema.safeParse({ commandId: EPOCH, source: 'dsh-cli', cwd: '/work' }).success, true);
    assert.equal(cliResumeCommand({ source: 'dsh-cli', cwd: '/work', providerSessionId: 'dsh-id' }), undefined);
    assert.equal(dshAcpProfile.mapOptionKind('allow_once'), 'allow_once');
    assert.equal(dshAcpProfile.mapOptionKind('reject_once'), 'reject_once');
    assert.equal(dshAcpProfile.mapOptionKind('allow_always'), 'unknown');
  });

  it('describes real DSH tool arguments while bounding the approval preview', () => {
    const raw = { sessionUpdate: 'tool_call', title: 'bash', rawInput: { description: 'Write marker', command: 'printf ok > marker.txt', justification: 'Write inside the test workspace.' } };
    const result = describeDshToolUpdate(raw) as typeof raw;
    assert.equal(result.title, 'Write marker\nprintf ok > marker.txt\nWrite inside the test workspace.');
    assert.equal(raw.title, 'bash');
    assert.equal((describeDshToolUpdate({ ...raw, rawInput: { command: 'x'.repeat(5000) } }) as typeof raw).title.length, 4000);
    assert.equal(describeDshToolUpdate({ sessionUpdate: 'tool_call', title: 'tool' }) != null, true);
  });

  for (const decision of ['allow-once', 'reject-once', 'cancelled'] as const) {
    it(`writes a ${decision} permission response and closes through session/close`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lifeline-dsh-permission-'));
      const trace = join(dir, 'trace.jsonl');
      const events: AcpClientEvent[] = [];
      const client = new AcpClient({ profile: dshAcpProfile, command: process.execPath, args: [fixture, trace], cwd: dir, killGraceMs: 5, onEvent: event => events.push(event) });
      try {
        await client.start();
        await client.initialize();
        const created = await client.sessionNew({ cwd: dir });
        assert.equal(created.thinkingConfigId, 'reasoning_effort');
        const prompt = client.prompt('Run tests');
        const permission = await until(() => events.find((event): event is AcpPermissionEvent => event.type === 'permission'));
        assert.equal(JSON.stringify(permission.raw).includes('dsh-provider-id'), false);
        assert.deepEqual(await permission.respond({ outcome: 'selected', optionId: 'allow-always' }), { ok: false, state: 'unsupported-permission-option' });
        assert.deepEqual(await permission.respond(decision === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: decision }), { ok: true });
        await prompt;
        await client.close();
        const frames = readTrace(trace);
        assert.deepEqual(frames.find(frame => frame.id === 'permission-1')?.result, {
          outcome: decision === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: decision },
        });
        assert.equal(frames.at(-1)?.method, 'session/close');
        assert.deepEqual(frames.at(-1)?.params, { sessionId: 'dsh-provider-id' });
      }
      finally {
        await client.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('routes catalogs, model changes, approvals, stop and restart recovery through the live entry', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lifeline-dsh-live-')));
    const trace = join(dir, 'trace.jsonl');
    const ledger = join(dir, 'sessions.json');
    const emitted: Array<{ event: string; payload: any }> = [];
    const options = {
      epoch: EPOCH,
      platform: 'darwin' as const,
      env: { ...process.env, LIFELINE_DSH_CLI: '/opt/bin/dsh' },
      ledgerPath: ledger,
      emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
      construct: (input: ConstructorParameters<typeof AcpClient>[0]) => new AcpClient({ ...input, command: process.execPath, args: [fixture, trace], killGraceMs: 5 }),
    };
    const entry = createLiveCliEntry(options);
    let restored: ReturnType<typeof createLiveCliEntry> | undefined;
    try {
      await entry.acceptCatalog({ commandId: EPOCH, source: 'dsh-cli', cwd: dir });
      const catalogResult = emitted.find(item => item.event === 'command:result')?.payload;
      assert.equal(catalogResult.ok, true);
      assert.equal(catalogResult.data.catalog.models[0].id, MODEL_A);
      assert.equal(catalogResult.data.catalog.thinking.current, 'medium');
      const started = await entry.start({ source: 'dsh-cli', cwd: dir, modelId: MODEL_B, thinking: 'high' });
      assert.equal(started.ok, true);
      if (!started.ok)
        return;
      const target = { source: 'dsh-cli' as const, sessionId: started.data.sessionId };
      const status = () => emitted.filter(item => item.event === 'cli:status').at(-1)?.payload;
      assert.equal(status().catalog.currentModelId, MODEL_B);
      assert.deepEqual(status().catalog.thinking.levels.map((level: { value: string }) => level.value), ['low', 'high']);
      assert.equal(status().catalog.thinking.current, 'high');
      assert.equal(status().resumeCommand, undefined);
      assert.deepEqual(await entry.manager.selectModel({ ...target, modelId: MODEL_A }), { ok: true });
      assert.deepEqual(status().catalog.thinking.levels.map((level: { value: string }) => level.value), ['medium', 'high']);
      assert.deepEqual(await entry.manager.selectThinking({ ...target, thinking: 'high' }), { ok: true });
      assert.equal(readCliSessionLedger(ledger)[0]?.thinking, 'high');
      assert.deepEqual(entry.manager.prompt({ ...target, text: 'Run tests', clientMessageId: 'message-1' }), { ok: true });
      const approval = await until(() => emitted.find(item => item.event === 'cli:approval')?.payload.approval);
      assert.equal(approval.title, 'Run project tests\nnpm test\nRun tests in the temporary workspace.');
      assert.deepEqual(approval.options.map((option: { kind: string }) => option.kind), ['allow_once', 'reject_once']);
      assert.deepEqual(await entry.manager.respond({ ...target, approvalId: approval.approvalId, response: { outcome: 'selected', optionId: 'allow-once' } }), { ok: true });
      await until(() => status()?.status === 'idle' ? true : undefined);
      assert.ok(emitted.some(item => item.event === 'cli:append' && item.payload.messages.some((message: { text?: string }) => message.text === 'Finished')));
      assert.deepEqual(entry.manager.prompt({ ...target, text: 'Stop this run', clientMessageId: 'message-2' }), { ok: true });
      await until(() => status()?.status === 'waiting_approval' ? true : undefined);
      assert.deepEqual(await entry.manager.stop(target), { ok: true });
      await until(() => status()?.status === 'idle' ? true : undefined);
      assert.deepEqual(entry.manager.prompt({ ...target, text: '__FAIL__', clientMessageId: 'message-fail' }), { ok: true });
      await until(() => status()?.error ? true : undefined);
      assert.equal(status().status, 'idle');
      assert.match(status().error, /DeepSeek Harness 请求失败/);
      await entry.manager.closeAll();
      restored = createLiveCliEntry({ ...options, epoch: '22222222-2222-4222-8222-222222222222' });
      await restored.manager.restore();
      assert.equal(status().status, 'idle');
      assert.equal(status().catalog.thinking.current, 'high');
      assert.ok(readTrace(trace).some(frame => frame.method === 'session/resume'));
      assert.equal(readTrace(trace).some(frame => frame.method === 'session/load'), false);
    }
    finally {
      await entry.manager.closeAll();
      await restored?.manager.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
