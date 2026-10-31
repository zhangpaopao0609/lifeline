import type { AcpProfile } from '../packages/agent/src/drivers/acp/profiles.js';
import type { AcpClientEvent, AcpPermissionEvent } from '../packages/agent/src/drivers/acp/types.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../packages/agent/src/drivers/acp/client.js';
import { codebuddyAcpProfile, cursorAcpProfile } from '../packages/agent/src/drivers/acp/profiles.js';

const fixturePath = fileURLToPath(new URL('./fixtures/mock-acp-agent.mjs', import.meta.url));
const providerSessionId = 'prov-session-9';
const secret = 'llk_7f3a9c2e1b';

describe('AcpClient', { concurrency: 1, timeout: 20_000 }, () => {
  it('sends initialize clientCapabilities without fs or terminal', async () => {
    await withClient(cursorAcpProfile, ['--fs-request'], async ({ client, readTrace }) => {
      assert.deepEqual(await client.initialize(), { protocolVersion: 1 });
      const init = await waitForMessage(readTrace, message => message.method === 'initialize');
      assert.deepEqual(init.params, {
        protocolVersion: 1,
        clientCapabilities: { _meta: { parameterizedModelPicker: true } },
      });
      assert.equal(JSON.stringify(init.params).includes('"fs"'), false);
      assert.equal(JSON.stringify(init.params).includes('"terminal"'), false);
      const fsReply = await waitForMessage(readTrace, message => message.id === 'fs-1');
      assert.equal(fsReply.method, undefined);
      assert.deepEqual(fsReply.error, { code: -32601, message: 'Method not found' });
    });
    await withClient(codebuddyAcpProfile, [], async ({ client, readTrace }) => {
      await client.initialize();
      const init = await waitForMessage(readTrace, message => message.method === 'initialize');
      assert.deepEqual(init.params, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
    });
  });

  it('returns sessionId, models, and modes and keeps the provider session id off events', async () => {
    await withClient(cursorAcpProfile, ['--permission', 'cursor'], async ({ client, events, readTrace }) => {
      await client.initialize();
      assert.deepEqual(await client.sessionNew({ cwd: '/tmp/proj' }), {
        sessionId: providerSessionId,
        models: [{ id: 'm1', name: 'Model One' }],
        modes: [
          { id: 'agent', name: 'Agent' },
          { id: 'plan', name: 'Plan' },
          { id: 'ask', name: 'Ask' },
        ],
        catalog: {
          models: [{ id: 'm1', label: 'Model One' }],
        },
      });
      const created = await waitForMessage(readTrace, message => message.method === 'session/new');
      assert.deepEqual(created.params, { cwd: '/tmp/proj', mcpServers: [] });
      const update = await waitForEvent(events, (event): event is Extract<AcpClientEvent, { type: 'update' }> => event.type === 'update');
      assert.deepEqual(update, {
        type: 'update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      });
      const permission = await waitForEvent(events, (event): event is AcpPermissionEvent => event.type === 'permission');
      assert.deepEqual(Object.keys(permission).sort(), ['raw', 'respond', 'type']);
      assert.deepEqual(permission.raw, {
        toolCall: {
          toolCallId: 'tool-1',
          title: 'npm test',
          kind: 'execute',
          rawInput: {},
        },
        options: [
          { optionId: 'allow-once', name: '  Allow once  ', kind: 'allow-once' },
          { optionId: 'allow-always', name: 'Allow always', kind: 'allow-always' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject-once' },
        ],
      });
      assert.equal(JSON.stringify(update).includes(providerSessionId), false);
      assert.equal(JSON.stringify(permission.raw).includes(providerSessionId), false);
      assert.equal(JSON.stringify(permission.raw).includes('perm-1'), false);
    });
  });

  it('unwraps nested session/new models and modes', async () => {
    await withClient(cursorAcpProfile, ['--session-shape', 'nested'], async ({ client }) => {
      await client.initialize();
      assert.deepEqual(await client.sessionNew({ cwd: '/tmp/proj' }), {
        sessionId: providerSessionId,
        models: [{ modelId: 'm1', name: 'Model One' }],
        modes: [
          { id: 'agent', name: 'Agent' },
          { id: 'plan', name: 'Plan' },
          { id: 'ask', name: 'Ask' },
        ],
        catalog: {
          models: [{ id: 'm1', label: 'Model One' }],
          currentModelId: 'm1',
        },
      });
    });
  });

  it('writes the selected permission result on the inbound response and does not send another request', async () => {
    await withClient(cursorAcpProfile, ['--permission', 'cursor'], async ({ client, events, readTrace }) => {
      await client.initialize();
      await client.sessionNew({ cwd: '/tmp/proj' });
      const permission = await waitForEvent(events, (event): event is AcpPermissionEvent => event.type === 'permission');
      assert.deepEqual(await permission.respond({ outcome: 'selected', optionId: 'allow-always' }), { ok: true });
      const written = await waitForMessage(readTrace, message => message.id === 'perm-1');
      assert.equal(written.method, undefined);
      assert.deepEqual(written.result, {
        outcome: { outcome: 'selected', optionId: 'allow-always' },
      });
      const inbound = (await readTrace()).flatMap(entry => entry.type === 'in' ? [entry.message] : []);
      assert.deepEqual(inbound.filter(message => message.id === 'perm-1'), [written]);
      assert.deepEqual(
        inbound.map(message => message.method).filter(method => typeof method === 'string'),
        ['initialize', 'session/new'],
      );
    });
  });

  it('writes a cancelled permission result without translating the option id', async () => {
    await withClient(codebuddyAcpProfile, ['--permission', 'codebuddy'], async ({ client, events, readTrace }) => {
      await client.initialize();
      await client.sessionNew({ cwd: '/tmp/proj' });
      const permission = await waitForEvent(events, (event): event is AcpPermissionEvent => event.type === 'permission');
      assert.deepEqual(await permission.respond({ outcome: 'cancelled' }), { ok: true });
      const written = await waitForMessage(readTrace, message => message.id === 'perm-1');
      assert.deepEqual(written.result, { outcome: { outcome: 'cancelled' } });
      assert.equal(written.method, undefined);
    });
  });

  it('keeps the provider optionId when the classified kind differs', async () => {
    await withClient(codebuddyAcpProfile, ['--permission', 'codebuddy'], async ({ client, events, readTrace }) => {
      await client.initialize();
      await client.sessionNew({ cwd: '/tmp/proj' });
      const permission = await waitForEvent(events, (event): event is AcpPermissionEvent => event.type === 'permission');
      assert.deepEqual(await permission.respond({ outcome: 'selected', optionId: 'allow' }), { ok: true });
      const written = await waitForMessage(readTrace, message => message.id === 'perm-1');
      assert.deepEqual(written.result, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    });
  });

  it('does not auto-submit an unknown option kind and does not write a result for it', async () => {
    await withClient(cursorAcpProfile, ['--permission', 'unknown'], async ({ client, events, readTrace }) => {
      await client.initialize();
      await client.sessionNew({ cwd: '/tmp/proj' });
      const permission = await waitForEvent(events, (event): event is AcpPermissionEvent => event.type === 'permission');
      await delay(150);
      assert.equal((await messagesWithId(readTrace, 'perm-1')).length, 0);
      assert.deepEqual(
        await permission.respond({ outcome: 'selected', optionId: 'custom' }),
        { ok: false, state: 'unsupported-permission-option' },
      );
      await delay(50);
      assert.equal((await messagesWithId(readTrace, 'perm-1')).length, 0);
      assert.deepEqual(await permission.respond({ outcome: 'cancelled' }), { ok: true });
      const written = await waitForMessage(readTrace, message => message.id === 'perm-1');
      assert.deepEqual(written.result, { outcome: { outcome: 'cancelled' } });
      assert.equal((await messagesWithId(readTrace, 'perm-1')).length, 1);
    });
  });

  it('rejects a pending prompt and emits exit without the provider session id when the process exits', async () => {
    await withClient(cursorAcpProfile, ['--exit-on-prompt'], async ({ client, events }) => {
      await client.initialize();
      const created = await client.sessionNew({ cwd: '/tmp/proj' });
      assert.equal(created.sessionId, providerSessionId);
      const pending = client.prompt('run the tests');
      const exit = waitForEvent(events, (event): event is Extract<AcpClientEvent, { type: 'exit' }> => event.type === 'exit');
      await assert.rejects(pending, (err: unknown) => {
        assert.equal((err as { code?: string }).code, 'closed');
        return true;
      });
      assert.deepEqual(await exit, { type: 'exit', code: 7, signal: null });
      for (const event of events) {
        const payload = event.type === 'permission' ? event.raw : event;
        assert.equal(JSON.stringify(payload).includes(providerSessionId), false);
      }
    });
  });

  it('sends prompt and cancel with the provider session id only on the child wire', async () => {
    await withClient(cursorAcpProfile, [], async ({ client, events, readTrace }) => {
      await client.initialize();
      await assert.rejects(client.prompt('too soon'), (err: unknown) => {
        assert.equal(JSON.stringify(err).includes(providerSessionId), false);
        assert.match((err as Error).message, /session/i);
        return true;
      });
      await client.sessionNew({ cwd: '/tmp/proj' });
      assert.deepEqual(await client.prompt('ping'), { stopReason: 'end_turn' });
      await client.cancel();
      const prompt = await waitForMessage(readTrace, message => message.method === 'session/prompt');
      assert.deepEqual(prompt.params, {
        sessionId: providerSessionId,
        prompt: [{ type: 'text', text: 'ping' }],
      });
      const cancel = await waitForMessage(readTrace, message => message.method === 'session/cancel');
      assert.equal(cancel.id, undefined);
      assert.deepEqual(cancel.params, { sessionId: providerSessionId });
      for (const event of events) {
        const payload = event.type === 'permission' ? event.raw : event;
        assert.equal(JSON.stringify(payload).includes(providerSessionId), false);
      }
    });
  });

  it('injects the codebuddy key and ioa environment and does not inject them for cursor', async () => {
    await withClient(codebuddyAcpProfile, [], async ({ readTrace }) => {
      const env = await waitForEnv(readTrace);
      assert.equal(env.CODEBUDDY_API_KEY, secret);
      assert.equal(env.CODEBUDDY_INTERNET_ENVIRONMENT, 'ioa');
    }, { apiKey: secret, environment: 'ioa' });

    await withClient(cursorAcpProfile, [], async ({ readTrace }) => {
      const env = await waitForEnv(readTrace);
      assert.equal(env.CODEBUDDY_API_KEY, null);
      assert.equal(env.CODEBUDDY_INTERNET_ENVIRONMENT, null);
    }, { apiKey: secret, environment: 'ioa' });
  });

  it('omits the codebuddy key from errors and console output when the provider echoes it', async () => {
    const logs: unknown[][] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const original = Object.fromEntries(methods.map(method => [method, console[method]])) as Record<(typeof methods)[number], (...args: unknown[]) => void>;
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        logs.push(args);
      };
    }
    try {
      await withClient(codebuddyAcpProfile, ['--fail-initialize'], async ({ client }) => {
        await assert.rejects(client.initialize(), (err: unknown) => {
          assert.equal(mentionsSecret(err), false);
          assert.equal((err as { rpcCode?: number }).rpcCode, -32001);
          return true;
        });
      }, { apiKey: secret, environment: 'ioa' });
    }
    finally {
      for (const method of methods)
        console[method] = original[method] as typeof console.log;
    }
    assert.equal(JSON.stringify(logs).includes(secret), false);
  });
});

interface TraceEntry {
  type: string;
  message?: TraceMessage;
  CODEBUDDY_API_KEY?: string | null;
  CODEBUDDY_INTERNET_ENVIRONMENT?: string | null;
}

interface TraceMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ClientHandle {
  client: AcpClient;
  events: AcpClientEvent[];
  readTrace: () => Promise<TraceEntry[]>;
}

async function withClient(
  profile: AcpProfile,
  fixtureArgs: string[],
  fn: (handle: ClientHandle) => Promise<void>,
  options?: { apiKey?: string; environment?: string },
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'acp-client-'));
  const tracePath = path.join(dir, 'trace.ndjson');
  const events: AcpClientEvent[] = [];
  const client = new AcpClient({
    profile,
    command: process.execPath,
    args: [fixturePath, '--trace', tracePath, ...fixtureArgs],
    cwd: dir,
    apiKey: options?.apiKey,
    environment: options?.environment,
    killGraceMs: 50,
    onEvent(event) {
      events.push(event);
    },
  });
  try {
    await client.start();
    await fn({
      client,
      events,
      readTrace: async () => readTrace(tracePath),
    });
  }
  finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function readTrace(tracePath: string): Promise<TraceEntry[]> {
  try {
    const text = await readFile(tracePath, 'utf8');
    return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as TraceEntry);
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw err;
  }
}

async function waitForMessage(readTrace: () => Promise<TraceEntry[]>, predicate: (message: TraceMessage) => boolean): Promise<TraceMessage> {
  const entry = await waitFor(async () => {
    const trace = await readTrace();
    return trace.find(item => item.type === 'in' && item.message != null && predicate(item.message));
  });
  return entry.message!;
}

async function messagesWithId(readTrace: () => Promise<TraceEntry[]>, id: string): Promise<TraceMessage[]> {
  return (await readTrace()).flatMap((entry) => {
    if (entry.type !== 'in' || entry.message?.id !== id)
      return [];
    return [entry.message];
  });
}

async function waitForEnv(readTrace: () => Promise<TraceEntry[]>): Promise<TraceEntry> {
  return waitFor(async () => {
    const trace = await readTrace();
    return trace.find(entry => entry.type === 'env');
  });
}

async function waitForEvent<T extends AcpClientEvent>(events: AcpClientEvent[], predicate: (event: AcpClientEvent) => event is T): Promise<T> {
  return waitFor(async () => events.find(predicate));
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value != null)
      return value;
    await delay(10);
  }
  throw new Error('timed out waiting for ACP fixture');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mentionsSecret(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string')
      return value.includes(secret);
    if (typeof value !== 'object' || value == null)
      return false;
    if (seen.has(value))
      return false;
    seen.add(value);
    if (value instanceof Error) {
      if (value.message.includes(secret) || (value.stack?.includes(secret) ?? false) || value.name.includes(secret))
        return true;
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (visit((value as Record<string, unknown>)[key]))
        return true;
    }
    for (const key of Object.keys(value)) {
      if (visit((value as Record<string, unknown>)[key]))
        return true;
    }
    return false;
  };
  return visit(err);
}
