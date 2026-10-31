import type { JsonlRpcNotification } from '../packages/agent/src/drivers/acp/jsonl-rpc.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACP_LINE_MAX_BYTES, ACP_STDERR_MAX_BYTES } from '@lifeline/protocol';
import {
  DEFAULT_KILL_GRACE_MS,
  JsonlRpc,
  JsonlRpcError,
  JsonlRpcMethodNotFound,
  JsonlRpcRemoteError,
  MAX_LINE_BYTES,
  resolveTimeoutMs,
} from '../packages/agent/src/drivers/acp/jsonl-rpc.js';

const fixturePath = fileURLToPath(new URL('./fixtures/mock-jsonl-agent.mjs', import.meta.url));

describe('JsonlRpc', { concurrency: 1, timeout: 20_000 }, () => {
  describe('budgets and timeouts', () => {
    it('aliases the protocol line cap and defaults kill grace to the controller value', () => {
      assert.equal(MAX_LINE_BYTES, ACP_LINE_MAX_BYTES);
      assert.equal(DEFAULT_KILL_GRACE_MS, 5_000);
      const rpc = new JsonlRpc({ command: process.execPath });
      assert.equal(rpc.killGraceMs, 5_000);
    });

    it('leaves prompt and permission untimed and times out every other method at 15000ms', () => {
      assert.equal(resolveTimeoutMs('initialize'), 15_000);
      assert.equal(resolveTimeoutMs('session/new'), 15_000);
      assert.equal(resolveTimeoutMs('session/cancel'), 15_000);
      assert.equal(resolveTimeoutMs('session/load'), 15_000);
      assert.equal(resolveTimeoutMs('session/prompt'), null);
      assert.equal(resolveTimeoutMs('session/request_permission'), null);
      assert.equal(resolveTimeoutMs('acp/permission'), null);
      assert.equal(resolveTimeoutMs('initialize', null), null);
      assert.equal(resolveTimeoutMs('session/prompt', 40), 40);
      assert.equal(resolveTimeoutMs('initialize', 0), 0);
    });

    it('times out initialize, session/new, and other methods at 15000ms without timing out prompt or permission', { timeout: 30_000 }, async () => {
      await withRpc('silent', {}, async (rpc) => {
        const started = Date.now();
        const init = rpc.sendRequest('initialize', {});
        const created = rpc.sendRequest('session/new', {});
        const other = rpc.sendRequest('session/cancel', {});
        const prompt = rpc.sendRequest('session/prompt', {});
        const permission = rpc.sendRequest('session/request_permission', {});
        const forever = rpc.sendRequest('initialize', {}, { timeoutMs: null });
        await init.written;
        const timedOut = Promise.all([
          assert.rejects(init.response, hasCode('timeout')),
          assert.rejects(created.response, hasCode('timeout')),
          assert.rejects(other.response, hasCode('timeout')),
        ]);
        const stillPending = Promise.all([
          prompt.response.then(() => 'settled', () => 'settled'),
          permission.response.then(() => 'settled', () => 'settled'),
          forever.response.then(() => 'settled', () => 'settled'),
        ]);
        await timedOut;
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 14_000, `elapsed ${elapsed}`);
        assert.ok(elapsed < 20_000, `elapsed ${elapsed}`);
        const raced = await Promise.race([
          stillPending,
          delay(200).then(() => 'pending' as const),
        ]);
        assert.equal(raced, 'pending');
        assert.equal(rpc.hasExited, false);
      });
    });

    it('honors a caller timeoutMs and does not kill the process', async () => {
      await withRpc('silent', {}, async (rpc) => {
        const started = Date.now();
        const { written, response } = rpc.sendRequest('session/prompt', {}, { timeoutMs: 40 });
        await written;
        await assert.rejects(response, hasCode('timeout'));
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 30, `elapsed ${elapsed}`);
        assert.ok(elapsed < 2_000, `elapsed ${elapsed}`);
        assert.equal(rpc.hasExited, false);
        assert.equal(isAlive(rpc.pid!), true);
      });
    });
  });

  describe('requests', () => {
    it('correlates responses by id when they arrive out of order and ignores notifications', async () => {
      let settled = 0;
      let releaseNote: (() => void) | undefined;
      const noteChecked = new Promise<void>((resolve, reject) => {
        releaseNote = () => {
          delay(40).then(() => {
            try {
              assert.equal(settled, 0);
              resolve();
            }
            catch (err) {
              reject(err);
            }
          }).catch(reject);
        };
      });
      const tracked: Promise<unknown>[] = [];
      await withRpc('reverse', {
        onNotification(note: JsonlRpcNotification) {
          assert.equal(note.method, 'session/update');
          assert.deepEqual(note.params, { n: 1 });
          releaseNote?.();
        },
      }, async (rpc) => {
        const first = rpc.sendRequest('initialize', { n: 1 });
        const second = rpc.sendRequest('session/new', { n: 2 });
        for (const pending of [first.response, second.response]) {
          tracked.push(pending.then(() => {
            settled += 1;
          }, () => {
            settled += 1;
          }));
        }
        await Promise.all([first.written, second.written]);
        await noteChecked;
        assert.deepEqual(await first.response, { id: 1, method: 'initialize', params: { n: 1 } });
        assert.deepEqual(await second.response, { id: 2, method: 'session/new', params: { n: 2 } });
        await Promise.all(tracked);
      });
    });

    it('writes one frame and resolves written before the response', async () => {
      await withRpc('count', {}, async (rpc) => {
        const note = rpc.notify('session/cancel', { sessionId: 'abc' });
        const req = rpc.sendRequest('initialize', { a: 1 });
        let settled = false;
        const tracked = req.response.then(() => {
          settled = true;
        }, () => {
          settled = true;
        });
        await note.written;
        await req.written;
        assert.equal(settled, false);
        assert.deepEqual(await req.response, {
          count: 2,
          methods: ['session/cancel', 'initialize'],
        });
        await tracked;
      });
    });

    it('rejects a remote error without resolving a successful result', async () => {
      await withRpc('remote-error', {}, async (rpc) => {
        const { written, response } = rpc.sendRequest('initialize', {});
        await written;
        await assert.rejects(response, (err: unknown) => {
          assert.ok(err instanceof JsonlRpcRemoteError);
          assert.equal(err.rpcCode, -32001);
          assert.match(err.message, /provider failed/);
          return true;
        });
      });
    });
  });

  describe('inbound requests', () => {
    it('dispatches onRequest and writes one response', async () => {
      let seenMethod = '';
      let seenId: number | string | undefined;
      await withRpc('inbound', {
        onRequest(request) {
          seenMethod = request.method;
          seenId = request.id;
          assert.deepEqual(request.params, { title: 'run' });
          return { outcome: 'selected', optionId: 'allow' };
        },
      }, async (rpc) => {
        const { response } = rpc.sendRequest('initialize', {});
        assert.deepEqual(await response, {
          result: { outcome: 'selected', optionId: 'allow' },
          error: null,
        });
        assert.equal(seenMethod, 'session/request_permission');
        assert.equal(seenId, 'perm-1');
      });
    });

    it('replies -32601 when no handler is registered', async () => {
      await withRpc('unknown', {}, async (rpc) => {
        const { response } = rpc.sendRequest('initialize', {});
        assert.deepEqual(await response, {
          result: null,
          error: { code: -32601, message: 'Method not found' },
        });
      });
    });

    it('replies -32601 when the handler throws Method not found', async () => {
      await withRpc('unknown', {
        onRequest(request) {
          throw new JsonlRpcMethodNotFound(request.method);
        },
      }, async (rpc) => {
        const { response } = rpc.sendRequest('initialize', {});
        assert.deepEqual(await response, {
          result: null,
          error: { code: -32601, message: 'Method not found' },
        });
      });
    });

    it('replies -32603 when the handler throws', async () => {
      await withRpc('unknown', {
        onRequest() {
          throw new Error('boom: /secret/path');
        },
      }, async (rpc) => {
        const { response } = rpc.sendRequest('initialize', {});
        assert.deepEqual(await response, {
          result: null,
          error: { code: -32603, message: 'Internal error' },
        });
      });
    });
  });

  describe('byte limits', () => {
    it('kills the process once a stdout line exceeds the cap, before a newline, and rejects pending', async () => {
      await withRpc('huge', { extraArgs: ['--bytes', String(ACP_LINE_MAX_BYTES + 1)] }, async (rpc) => {
        const first = rpc.sendRequest('initialize', { n: 1 });
        const second = rpc.sendRequest('session/new', { n: 2 });
        const writes = Promise.all([
          first.written.then(() => undefined, () => undefined),
          second.written.then(() => undefined, () => undefined),
        ]);
        await Promise.all([
          assert.rejects(first.response, hasCode('line-too-large')),
          assert.rejects(second.response, hasCode('line-too-large')),
        ]);
        await writes;
        await waitFor(() => rpc.pid != null && !isAlive(rpc.pid));
      });
    });

    it('accepts a stdout line of exactly ACP_LINE_MAX_BYTES', async () => {
      await withRpc('exact', { extraArgs: ['--bytes', String(ACP_LINE_MAX_BYTES)] }, async (rpc) => {
        const { response } = rpc.sendRequest('initialize', {});
        const result = await response as { ok: boolean; pad: string };
        const prefix = `{"jsonrpc":"2.0","id":${JSON.stringify(1)},"result":{"ok":true,"pad":"`;
        const suffix = '"}}';
        const padLen = ACP_LINE_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
        assert.equal(result.ok, true);
        assert.equal(result.pad.length, padLen);
        assert.equal(isAlive(rpc.pid!), true);
      });
    });

    it('keeps the newest stderr bytes and returns a copy', async () => {
      const extra = 100;
      await withRpc('stderr', {
        extraArgs: ['--bytes', String(ACP_STDERR_MAX_BYTES), '--stderr-extra', String(extra)],
      }, async (rpc) => {
        await waitFor(() => rpc.stderrTail.length === ACP_STDERR_MAX_BYTES && rpc.stderrTail[rpc.stderrTail.length - 1] === 0x42);
        const tail = rpc.stderrTail;
        assert.equal(tail.length, ACP_STDERR_MAX_BYTES);
        assert.ok(tail.subarray(0, ACP_STDERR_MAX_BYTES - extra).every(byte => byte === 0x41));
        assert.ok(tail.subarray(ACP_STDERR_MAX_BYTES - extra).every(byte => byte === 0x42));
        const snapshot = Buffer.from(tail);
        tail[0] = 0;
        assert.deepEqual(rpc.stderrTail, snapshot);
        assert.deepEqual(await rpc.sendRequest('initialize', { ok: true }).response, {
          id: 1,
          method: 'initialize',
          params: { ok: true },
        });
      });
    });
  });

  describe('spawn failures', () => {
    it('maps a missing binary to binary-missing', async () => {
      const rpc = new JsonlRpc({
        command: path.join(tmpdir(), 'lifeline-missing-acp-binary'),
        killGraceMs: 200,
      });
      await assert.rejects(rpc.start(), (err: unknown) => {
        assert.ok(err instanceof JsonlRpcError);
        assert.equal(err.code, 'binary-missing');
        return true;
      });
      await rpc.close();
    });

    it('maps a non-executable binary to binary-not-executable', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'lifeline-jsonl-'));
      try {
        const file = path.join(dir, 'agent');
        await writeFile(file, '#!/bin/sh\necho hi\n');
        await chmod(file, 0o644);
        const rpc = new JsonlRpc({ command: file, killGraceMs: 200 });
        await assert.rejects(rpc.start(), (err: unknown) => {
          assert.ok(err instanceof JsonlRpcError);
          assert.equal(err.code, 'binary-not-executable');
          return true;
        });
        await rpc.close();
      }
      finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('close', () => {
    it('is idempotent before start and rejects sendRequest', async () => {
      const rpc = new JsonlRpc({ command: process.execPath, args: ['-e', 'process.exit(0)'] });
      const first = rpc.close();
      assert.equal(rpc.close(), first);
      await first;
      const { written, response } = rpc.sendRequest('initialize', {});
      await Promise.all([
        assert.rejects(written, hasCode('closed')),
        assert.rejects(response, hasCode('closed')),
      ]);
    });

    it('awaiting only response does not surface an unhandled rejection when the child is already gone', async () => {
      const rpc = new JsonlRpc({
        command: process.execPath,
        args: [fixturePath, '--mode', 'exit-now'],
        killGraceMs: 50,
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        await rpc.start();
        await waitFor(() => rpc.hasExited);
        const { written, response } = rpc.sendRequest('initialize', {});
        await assert.rejects(response);
        await new Promise<void>(resolve => setTimeout(resolve, 30));
        assert.deepEqual(unhandled, []);
        await assert.rejects(written);
      }
      finally {
        process.off('unhandledRejection', onUnhandled);
        await rpc.close();
      }
    });

    it('swallows ESRCH when the process group is already gone', async () => {
      const rpc = new JsonlRpc({
        command: process.execPath,
        args: [fixturePath, '--mode', 'exit-now'],
        killGraceMs: 5_000,
      });
      try {
        await rpc.start();
        await waitFor(() => rpc.hasExited);
        const started = Date.now();
        const first = rpc.close();
        assert.equal(rpc.close(), first);
        await first;
        assert.ok(Date.now() - started < 1_000, 'close waited for killGraceMs after ESRCH');
      }
      finally {
        await rpc.close();
      }
    });

    it('SIGTERMs the process group, then SIGKILLs grandchildren that ignore SIGTERM', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'lifeline-jsonl-'));
      const parentFile = path.join(dir, 'parent');
      const childFile = path.join(dir, 'child');
      let releaseReady: ((value: { pid: number; childPid: number }) => void) | undefined;
      const ready = new Promise<{ pid: number; childPid: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture did not become ready')), 3_000);
        releaseReady = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
      try {
        await withRpc('ignore-term', {
          killGraceMs: 300,
          extraArgs: ['--term-file', parentFile, '--child-term-file', childFile, '--ready-file', path.join(dir, 'ready')],
          onNotification(note) {
            if (note.method !== 'fixture/ready')
              return;
            const params = note.params as { pid?: unknown; childPid?: unknown };
            if (typeof params?.pid === 'number' && typeof params.childPid === 'number')
              releaseReady?.({ pid: params.pid, childPid: params.childPid });
          },
        }, async (rpc) => {
          const info = await ready;
          assert.equal(isAlive(info.pid), true);
          assert.equal(isAlive(info.childPid), true);
          assert.equal(processGroupId(info.pid), info.pid);
          assert.equal(processGroupId(info.childPid), info.pid);
          const started = Date.now();
          const first = rpc.close();
          assert.equal(rpc.close(), first);
          await first;
          const elapsed = Date.now() - started;
          assert.ok(elapsed >= 250, `elapsed ${elapsed}`);
          assert.ok(elapsed < 3_000, `elapsed ${elapsed}`);
          await waitFor(() => !isAlive(info.pid) && !isAlive(info.childPid));
          assert.equal(await readFile(parentFile, 'utf8'), 'term');
          assert.equal(await readFile(childFile, 'utf8'), 'term');
        });
      }
      finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('SIGKILLs the process group after the grace even when the direct child already exited', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'lifeline-jsonl-'));
      const childFile = path.join(dir, 'child');
      let releaseReady: ((value: { pid: number; childPid: number }) => void) | undefined;
      const ready = new Promise<{ pid: number; childPid: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture did not become ready')), 3_000);
        releaseReady = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
      try {
        await withRpc('exit-on-term', {
          killGraceMs: 300,
          extraArgs: ['--child-term-file', childFile, '--ready-file', path.join(dir, 'ready')],
          onNotification(note) {
            if (note.method !== 'fixture/ready')
              return;
            const params = note.params as { pid?: unknown; childPid?: unknown };
            if (typeof params?.pid === 'number' && typeof params.childPid === 'number')
              releaseReady?.({ pid: params.pid, childPid: params.childPid });
          },
        }, async (rpc) => {
          const info = await ready;
          assert.equal(isAlive(info.pid), true);
          assert.equal(isAlive(info.childPid), true);
          assert.equal(processGroupId(info.childPid), info.pid);
          const started = Date.now();
          await rpc.close();
          const elapsed = Date.now() - started;
          assert.ok(elapsed >= 250, `elapsed ${elapsed}`);
          assert.ok(elapsed < 3_000, `elapsed ${elapsed}`);
          await waitFor(() => !isAlive(info.pid) && !isAlive(info.childPid));
          assert.equal(await readFile(childFile, 'utf8'), 'term');
        });
      }
      finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('backpressure', () => {
    it('keeps written pending until stdin drain when write returns false', async () => {
      await withRpc('hold-stdin', {}, async (rpc) => {
        const guarded: Promise<unknown>[] = [];
        let held: Promise<void> | undefined;
        for (let i = 0; i < 64 && held == null; i += 1) {
          const { written, response } = rpc.sendRequest('session/prompt', {
            blob: 'x'.repeat(64 * 1024),
          });
          // Responses stay pending until close. Attach handlers now so that rejection is observed.
          guarded.push(response.then(() => undefined, () => undefined));
          const status = await Promise.race([
            written.then(() => 'done' as const, () => 'error' as const),
            delay(50).then(() => 'pending' as const),
          ]);
          if (status === 'error')
            assert.fail('stdin write failed before backpressure');
          if (status === 'pending') {
            const still = await Promise.race([
              written.then(() => 'done' as const, () => 'error' as const),
              delay(150).then(() => 'held' as const),
            ]);
            if (still === 'error')
              assert.fail('stdin write failed before backpressure');
            if (still === 'held')
              held = written;
          }
        }
        assert.ok(held, 'expected stdin backpressure');
        assert.ok(guarded.length > 0);
        process.kill(rpc.pid!, 'SIGUSR1');
        await held;
      });
    });
  });
});

interface OpenOptions {
  extraArgs?: string[];
  killGraceMs?: number;
  onRequest?: (request: { id: number | string; method: string; params?: unknown }) => unknown;
  onNotification?: (notification: JsonlRpcNotification) => void;
}

async function withRpc(mode: string, options: OpenOptions, fn: (rpc: JsonlRpc) => Promise<void>): Promise<void> {
  const rpc = new JsonlRpc({
    command: process.execPath,
    args: [fixturePath, '--mode', mode, ...(options.extraArgs ?? [])],
    killGraceMs: options.killGraceMs ?? 200,
    onRequest: options.onRequest,
    onNotification: options.onNotification,
  });
  try {
    await rpc.start();
    await fn(rpc);
  }
  finally {
    await rpc.close();
    if (rpc.pid != null && rpc.pid > 0) {
      try {
        process.kill(-rpc.pid, 'SIGKILL');
      }
      catch {
        // The group is already gone. ESRCH is the success path.
      }
    }
  }
}

function hasCode(code: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof JsonlRpcError);
    assert.equal(err.code, code);
    return true;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error('timed out waiting for condition');
    await delay(10);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function processGroupId(pid: number): number {
  const output = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  return Number(output.trim());
}
