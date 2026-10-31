import type { CliPermissionResponse } from '@lifeline/protocol';
import type { CliSessionClient } from '../packages/agent/src/cli-session-manager.js';
import type { AcpClientEvent } from '../packages/agent/src/drivers/acp/types.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliSessionManager } from '../packages/agent/src/cli-session-manager.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function stripComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
    .replace(/\s\/\/.*$/gm, '');
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Timer {
  at: number;
  fn: () => void;
  cleared: boolean;
}

function createClock() {
  let now = 0;
  const timers: Timer[] = [];
  const arm = (ms: number, fn: () => void) => {
    const timer: Timer = { at: now + ms, fn, cleared: false };
    timers.push(timer);
    return () => {
      timer.cleared = true;
    };
  };
  return {
    now: () => now,
    delay(ms: number) {
      return new Promise<void>((resolve) => {
        arm(ms, resolve);
      });
    },
    schedule(ms: number, fn: () => void) {
      return arm(ms, fn);
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = timers
          .filter(timer => !timer.cleared && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next)
          break;
        now = next.at;
        next.cleared = true;
        next.fn();
        await flush();
      }
      now = target;
    },
  };
}

async function loadLifecycle() {
  return import('../packages/agent/src/lifecycle.js') as Promise<typeof import('../packages/agent/src/lifecycle.js')>;
}

describe('createLifecycle', () => {
  it('runs one shutdown in order and ignores a second trigger', async () => {
    const { createLifecycle } = await loadLifecycle();
    const trace: string[] = [];
    const exits: number[] = [];
    const clock = createClock();
    const cancelled = [deferred<void>(), deferred<void>()];
    const cancel = deferred<void>();
    const cliGate = deferred<void>();
    const ideGate = deferred<void>();
    const lifecycle = createLifecycle({
      claimAndEnqueueCancelled() {
        trace.push('claim');
        trace.push('cancelled');
        trace.push('cancelled');
        return cancelled.map(item => item.promise);
      },
      enqueueCancels() {
        trace.push('cancel');
        return [cancel.promise];
      },
      closeCli() {
        trace.push('close-cli');
        return cliGate.promise;
      },
      closeIde() {
        trace.push('close-ide');
        return ideGate.promise;
      },
      disconnect() {
        trace.push('disconnect');
      },
      releaseLock() {
        trace.push('release');
      },
      exit(code) {
        trace.push('exit');
        exits.push(code);
      },
    }, {
      delay: clock.delay,
      schedule: clock.schedule,
    });

    const first = lifecycle.shutdown(0);
    const second = lifecycle.shutdown(1);
    await flush();
    assert.equal(lifecycle.shuttingDown, true);
    assert.deepEqual(trace, ['claim', 'cancelled', 'cancelled', 'cancel']);
    await second;
    assert.deepEqual(exits, []);

    await clock.advance(199);
    await flush();
    assert.equal(trace.includes('close-cli'), false, 'drain stays inside 200ms');
    await clock.advance(1);
    await flush();
    const closeCliAt = trace.indexOf('close-cli');
    const closeIdeAt = trace.indexOf('close-ide');
    assert.ok(closeCliAt !== -1 && closeIdeAt !== -1);
    assert.equal(trace.includes('disconnect'), false, 'uplink stays up until both closes finish');
    ideGate.resolve();
    await flush();
    assert.equal(trace.includes('disconnect'), false, 'one finished close does not drop the uplink');
    cliGate.resolve();
    await first;
    assert.deepEqual(trace.slice(closeCliAt), [
      'close-cli',
      'close-ide',
      'disconnect',
      'release',
      'exit',
    ]);
    assert.deepEqual(exits, [0]);
  });

  it('does not spend a drain budget per cancelled approval', async () => {
    const { createLifecycle } = await loadLifecycle();
    const clock = createClock();
    let closes = 0;
    const lifecycle = createLifecycle({
      claimAndEnqueueCancelled: () => [new Promise<void>(() => {}), new Promise<void>(() => {}), new Promise<void>(() => {})],
      enqueueCancels: () => [new Promise<void>(() => {})],
      closeCli() {
        closes += 1;
        return new Promise<void>(() => {});
      },
      closeIde: () => new Promise<void>(() => {}),
      disconnect() {},
      releaseLock() {},
      exit() {},
    }, {
      delay: clock.delay,
      schedule: clock.schedule,
    });
    void lifecycle.shutdown(0);
    await flush();
    assert.equal(closes, 0);
    await clock.advance(200);
    await flush();
    assert.equal(closes, 1);
  });

  it('closes as soon as cancel work settles, without waiting out the drain', async () => {
    const { createLifecycle } = await loadLifecycle();
    const clock = createClock();
    const trace: string[] = [];
    const lifecycle = createLifecycle({
      claimAndEnqueueCancelled() {
        trace.push('claim');
        return [Promise.resolve()];
      },
      enqueueCancels() {
        trace.push('cancel');
        return [Promise.resolve()];
      },
      closeCli() {
        trace.push('close-cli');
        return Promise.resolve();
      },
      closeIde() {
        trace.push('close-ide');
        return Promise.resolve();
      },
      disconnect() {
        trace.push('disconnect');
      },
      releaseLock() {
        trace.push('release');
      },
      exit() {
        trace.push('exit');
      },
    }, {
      delay: clock.delay,
      schedule: clock.schedule,
    });
    await lifecycle.shutdown(1);
    assert.equal(clock.now(), 0);
    assert.deepEqual(trace, ['claim', 'cancel', 'close-cli', 'close-ide', 'disconnect', 'release', 'exit']);
  });

  it('exits at 8000ms while a CLI child is still closing', async () => {
    const { createLifecycle } = await loadLifecycle();
    const clock = createClock();
    const trace: string[] = [];
    const exits: number[] = [];
    const lifecycle = createLifecycle({
      claimAndEnqueueCancelled: () => [],
      enqueueCancels: () => [],
      closeCli() {
        trace.push('close-cli');
        return new Promise<void>(() => {});
      },
      closeIde() {
        trace.push('close-ide');
        return Promise.resolve();
      },
      disconnect() {
        trace.push('disconnect');
      },
      releaseLock() {
        trace.push('release');
      },
      exit(code) {
        trace.push('exit');
        exits.push(code);
      },
    }, {
      delay: clock.delay,
      schedule: clock.schedule,
    });
    const pending = lifecycle.shutdown(1);
    await flush();
    assert.deepEqual(trace, ['close-cli', 'close-ide']);
    await clock.advance(7999);
    await flush();
    assert.deepEqual(exits, []);
    await clock.advance(1);
    await pending;
    assert.deepEqual(exits, [1]);
    assert.deepEqual(trace, ['close-cli', 'close-ide', 'disconnect', 'release', 'exit']);
  });

  it('defaults the drain to 200ms and the hard deadline to 8000ms', async () => {
    const { createLifecycle } = await loadLifecycle();
    const delays: number[] = [];
    const deadlines: number[] = [];
    const lifecycle = createLifecycle({
      claimAndEnqueueCancelled: () => [new Promise<void>(() => {})],
      enqueueCancels: () => [new Promise<void>(() => {})],
      closeCli: () => new Promise<void>(() => {}),
      closeIde: () => Promise.resolve(),
      disconnect() {},
      releaseLock() {},
      exit() {},
    }, {
      delay(ms) {
        delays.push(ms);
        return new Promise<void>(() => {});
      },
      schedule(ms) {
        deadlines.push(ms);
        return () => {};
      },
    });
    void lifecycle.shutdown(0);
    await flush();
    assert.deepEqual(delays, [200]);
    assert.deepEqual(deadlines, [8000]);
  });
});

describe('CliSessionManager shutdown phases', () => {
  it('enqueues every cancelled approval before cancel, and close does not wait on the provider', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'lifeline-shutdown-cli-'));
    try {
      const calls: string[] = [];
      const respondGate = deferred<void>();
      let onEvent: (event: AcpClientEvent) => void = () => {};
      const client: CliSessionClient = {
        start: async () => {
          calls.push('start');
        },
        initialize: async () => ({ protocolVersion: 1 }),
        sessionNew: async () => ({ sessionId: 'provider-secret', models: [], modes: [] }),
        prompt: () => new Promise(() => {}),
        cancel: async () => {
          calls.push('cancel');
        },
        close: async () => {
          calls.push('close');
        },
      };
      const manager = new CliSessionManager({
        epoch: 'epoch-1',
        emit() {},
        createClient(input) {
          onEvent = input.onEvent;
          return client;
        },
      });
      const started = await manager.start({ source: 'cursor-cli', cwd });
      assert.equal(started.ok, true);
      const hangRespond = (response: CliPermissionResponse) => {
        calls.push(`respond:${response.outcome}`);
        return respondGate.promise.then(() => ({ ok: true as const }));
      };
      onEvent(permissionEvent(hangRespond));
      onEvent(permissionEvent(hangRespond));

      const inflight = manager.claimAndEnqueueCancelled();
      assert.deepEqual(calls.filter(call => call.startsWith('respond:')), ['respond:cancelled', 'respond:cancelled']);
      assert.equal(calls.includes('cancel'), false);
      assert.equal(calls.includes('close'), false);
      let settled = false;
      void Promise.all(inflight).then(() => {
        settled = true;
      });
      await flush();
      assert.equal(settled, false, 'cancelled responses stay in flight');

      await Promise.all(manager.enqueueCancels());
      assert.equal(calls.includes('cancel'), true);
      assert.equal(calls.includes('close'), false);

      await manager.closeAll();
      assert.equal(calls.includes('close'), true);
      assert.equal(settled, false, 'close does not wait for the provider to finish cancelled');
    }
    finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses a new start once shutdown has claimed approvals', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'lifeline-shutdown-cli-'));
    try {
      let clients = 0;
      const manager = new CliSessionManager({
        epoch: 'epoch-1',
        emit() {},
        createClient(input) {
          clients += 1;
          return quietClient(input.onEvent);
        },
      });
      assert.equal((await manager.start({ source: 'cursor-cli', cwd })).ok, true);
      manager.claimAndEnqueueCancelled();
      const again = await manager.start({ source: 'cursor-cli', cwd });
      assert.deepEqual(again, { ok: false, errorCode: 'shutting-down' });
      assert.equal(clients, 1);
    }
    finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('agent index shutdown wiring', () => {
  const source = stripComments(readFileSync(path.join(repoRoot, 'packages/agent/src/index.ts'), 'utf-8'));

  it('sends SIGINT, SIGTERM, superseded stand-down, and fatal through one shutdown', () => {
    const sigint = source.indexOf('process.on(\'SIGINT\'');
    const sigterm = source.indexOf('process.on(\'SIGTERM\'');
    assert.notEqual(sigint, -1);
    assert.notEqual(sigterm, -1);
    assert.match(source.slice(sigint, sigint + 500), /lifecycle\.shutdown\(0\)/);
    assert.match(source.slice(sigterm, sigterm + 500), /lifecycle\.shutdown\(0\)/);

    const at = source.indexOf('uplink.on(\'superseded\'');
    const next = source.indexOf('uplink.on(', at + 1);
    const handler = source.slice(at, next === -1 ? undefined : next);
    const guard = handler.indexOf('if (!standDown)');
    const enter = handler.indexOf('lifecycle.shutdown(1)');
    assert.notEqual(guard, -1, 'missing the keep-the-lock guard');
    assert.notEqual(enter, -1, 'stand-down must enter the shared shutdown');
    assert.ok(guard < enter, 'the guard must come before the side effects');
    assert.equal(handler.includes('process.exit'), false);

    const fatal = source.slice(source.indexOf('main().catch'));
    assert.match(fatal, /lifecycle\.shutdown\(1\)/);
    assert.equal(source.includes('process.exit(0)'), false);
  });

  it('mints one process id and passes it to both the uplink and the CLI manager', () => {
    const calls = source.match(/randomUUID\(\)/g) ?? [];
    assert.deepEqual(calls, ['randomUUID()']);
    const minted = source.indexOf('const instanceId = randomUUID()');
    const uplink = source.indexOf('new Uplink(');
    const epoch = source.indexOf('epoch: instanceId');
    assert.notEqual(minted, -1, 'index must mint the process id once');
    assert.ok(minted < uplink, 'the id must exist before the uplink is constructed');
    assert.match(source.slice(uplink, uplink + 400), /instanceId/);
    assert.notEqual(epoch, -1, 'the CLI manager epoch must be that same id');
    assert.ok(uplink < epoch);
  });

  it('closes CLI through the manager and still stops IDE slots', () => {
    assert.match(source, /claimAndEnqueueCancelled\(\)/);
    assert.match(source, /enqueueCancels\(\)/);
    assert.match(source, /closeAll\(\)/);
    assert.match(source, /slots\[kind\]!\.stop\(\)/);
    assert.equal(source.includes('process.kill'), false);
    const lifecycle = stripComments(readFileSync(path.join(repoRoot, 'packages/agent/src/lifecycle.ts'), 'utf-8'));
    assert.equal(lifecycle.includes('process.kill'), false);
  });
});

function permissionEvent(
  respond: (response: CliPermissionResponse) => Promise<{ ok: true }>,
): AcpClientEvent {
  return {
    type: 'permission',
    raw: {
      toolCall: { toolCallId: 'tool-1', title: 'npm test', kind: 'execute', rawInput: {} },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow-once' }],
    },
    respond,
  };
}

function quietClient(onEvent: (event: AcpClientEvent) => void): CliSessionClient {
  void onEvent;
  return {
    start: async () => {},
    initialize: async () => ({ protocolVersion: 1 }),
    sessionNew: async () => ({ sessionId: 'provider-secret', models: [], modes: [] }),
    prompt: () => new Promise(() => {}),
    cancel: async () => {},
    close: async () => {},
  };
}
