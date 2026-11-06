import type { CliCapabilities, CommandErrorCode } from '@lifeline/protocol';
import type { ChildProcess } from 'node:child_process';
import type { CheckedAtState, ReadinessClient } from '../packages/agent/src/drivers/acp/readiness.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { JsonlRpcRemoteError } from '../packages/agent/src/drivers/acp/jsonl-rpc.js';
import {
  acpSpawnAllowed,
  buildChildEnv,
  classifyReadinessSignal,
  probeReadiness,
  startProviderSession,
  withCliBinOnPath,
} from '../packages/agent/src/drivers/acp/readiness.js';
import {
  planLaunchdProviderSpawn,
  spawnAbsoluteProvider,
} from '../packages/cli/src/daemon/launchd.js';

const FAKE_KEY = 'llk_fake_not_a_real_secret';
const EPOCH = '11111111-1111-4111-8111-111111111111';
const SECRET_PATH = '/var/lifeline/secret-binary';

describe('acp readiness', { concurrency: 1, timeout: 20_000 }, () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs)
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lifeline-acp-ready-'));
    dirs.push(dir);
    return dir;
  }

  it('short-circuits availability in the required order', () => {
    const later = {
      env: { LIFELINE_LINUX_CDP: '1' },
      cwdAbsoluteDirectory: false,
      spawnCode: 'ENOENT' as const,
      protocolVersion: 2,
      authStructured: true,
      hasKey: false,
      phase: 'start' as const,
      ok: false,
    };
    const rows: Array<{ platform: NodeJS.Platform; patch: Partial<typeof later>; errorCode: CommandErrorCode; availability: string }> = [
      { platform: 'linux', patch: {}, errorCode: 'unsupported-platform', availability: 'error' },
      { platform: 'darwin', patch: { cwdAbsoluteDirectory: false }, errorCode: 'invalid-cwd', availability: 'error' },
      { platform: 'darwin', patch: { cwdAbsoluteDirectory: true }, errorCode: 'binary-missing', availability: 'binary-missing' },
      { platform: 'darwin', patch: { cwdAbsoluteDirectory: true, spawnCode: 'EACCES' }, errorCode: 'binary-not-executable', availability: 'error' },
      { platform: 'darwin', patch: { cwdAbsoluteDirectory: true, spawnCode: 'OK' }, errorCode: 'unsupported-acp-version', availability: 'error' },
      { platform: 'darwin', patch: { cwdAbsoluteDirectory: true, spawnCode: 'OK', protocolVersion: 1 }, errorCode: 'no-credential', availability: 'credential-required' },
      { platform: 'darwin', patch: { cwdAbsoluteDirectory: true, spawnCode: 'OK', protocolVersion: 1, hasKey: true }, errorCode: 'auth-rejected', availability: 'credential-required' },
      { platform: 'darwin', patch: { cwdAbsoluteDirectory: true, spawnCode: 'OK', protocolVersion: 1, authStructured: false, hasKey: true }, errorCode: 'provider-error', availability: 'error' },
    ];
    for (const row of rows) {
      const verdict = classifyReadinessSignal({ platform: row.platform, ...later, ...row.patch });
      assert.equal(verdict.errorCode, row.errorCode);
      assert.equal(verdict.availability, row.availability);
    }

    const probeOk = classifyReadinessSignal({
      platform: 'darwin',
      env: { LIFELINE_LINUX_CDP: '1' },
      cwdAbsoluteDirectory: true,
      spawnCode: 'OK',
      protocolVersion: 1,
      authStructured: false,
      hasKey: false,
      phase: 'probe',
      ok: true,
    });
    assert.equal(probeOk.errorCode, undefined);
    assert.equal(probeOk.availability, 'unknown');
    assert.notEqual(probeOk.availability, 'ready');

    const startOk = classifyReadinessSignal({
      platform: 'darwin',
      env: {},
      cwdAbsoluteDirectory: true,
      spawnCode: 'OK',
      protocolVersion: 1,
      authStructured: false,
      hasKey: true,
      phase: 'start',
      ok: true,
      listedModels: false,
    });
    assert.equal(startOk.errorCode, undefined);
    assert.equal(startOk.availability, 'ready');
    assert.equal((startOk.detail ?? '').includes('凭据已验证'), false);
  });

  it('does not treat linux or win32 as spawnable when LIFELINE_LINUX_CDP=1', () => {
    assert.equal(acpSpawnAllowed('linux', { LIFELINE_LINUX_CDP: '1' }), false);
    assert.equal(acpSpawnAllowed('win32', { LIFELINE_LINUX_CDP: '1' }), false);
    assert.equal(acpSpawnAllowed('darwin', { LIFELINE_LINUX_CDP: '1' }), true);
    const source = readFileSync(new URL('../packages/agent/src/drivers/acp/readiness.ts', import.meta.url), 'utf8');
    assert.equal(source.includes('canControlIde'), false);
  });

  it('probes with initialize only, closes the process, and reports unknown', async () => {
    const calls: string[] = [];
    const result = await probeReadiness({
      source: 'cursor-cli',
      command: '/usr/local/bin/cursor-agent',
      cwd: tempDir(),
      platform: 'darwin',
      epoch: EPOCH,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client(calls, {
        initialize: async () => {
          calls.push('initialize');
          return { protocolVersion: 1, agentCapabilities: {} };
        },
      }),
    });
    assert.deepEqual(calls, ['start', 'initialize', 'close']);
    assert.equal(result.availability, 'unknown');
    assert.notEqual(result.availability, 'ready');
    assert.equal(result.errorCode, undefined);
    assert.equal((result.detail ?? '').includes('凭据已验证'), false);
  });

  it('closes the probe when initialize throws', async () => {
    const calls: string[] = [];
    const result = await probeReadiness({
      source: 'cursor-cli',
      command: '/usr/local/bin/cursor-agent',
      cwd: tempDir(),
      platform: 'darwin',
      epoch: EPOCH,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client(calls, {
        initialize: async () => {
          calls.push('initialize');
          throw new Error(`boom ${FAKE_KEY} ${SECRET_PATH} 凭据已验证\u0001`);
        },
      }),
    });
    assert.deepEqual(calls, ['start', 'initialize', 'close']);
    assert.equal(result.errorCode, 'provider-error');
    assert.equal(result.availability, 'error');
    const detail = result.detail ?? '';
    assert.equal(detail.includes(FAKE_KEY), false);
    assert.equal(detail.includes(SECRET_PATH), false);
    assert.equal(detail.includes('凭据已验证'), false);
    assert.equal(detail.includes('\u0001'), false);
  });

  it('does not spawn when the platform or cwd fails first', async () => {
    let opened = 0;
    const cwd = tempDir();
    const blocked = await probeReadiness({
      source: 'cursor-cli',
      command: '/usr/local/bin/cursor-agent',
      cwd,
      platform: 'linux',
      env: { LIFELINE_LINUX_CDP: '1' },
      epoch: EPOCH,
      open: () => {
        opened += 1;
        return client([]);
      },
    });
    assert.equal(opened, 0);
    assert.equal(blocked.errorCode, 'unsupported-platform');

    const badCwd = await probeReadiness({
      source: 'cursor-cli',
      command: '/usr/local/bin/cursor-agent',
      cwd: 'relative/work',
      platform: 'darwin',
      epoch: EPOCH,
      open: () => {
        opened += 1;
        return client([]);
      },
    });
    assert.equal(opened, 0);
    assert.equal(badCwd.errorCode, 'invalid-cwd');

    const missingDir = await probeReadiness({
      source: 'codebuddy-cli',
      command: '/usr/local/bin/codebuddy',
      cwd: join(cwd, 'missing-dir'),
      platform: 'darwin',
      epoch: EPOCH,
      open: () => {
        opened += 1;
        return client([]);
      },
    });
    assert.equal(opened, 0);
    assert.equal(missingDir.errorCode, 'invalid-cwd');
  });

  it('classifies a missing binary and a non-executable file from spawn', async () => {
    const cwd = tempDir();
    const missing = join(cwd, 'missing-acp-binary');
    const missingResult = await probeReadiness({
      source: 'cursor-cli',
      command: missing,
      args: ['acp'],
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      killGraceMs: 50,
    });
    assert.equal(missingResult.errorCode, 'binary-missing');
    assert.equal(missingResult.availability, 'binary-missing');
    assert.equal((missingResult.detail ?? '').includes(missing), false);

    const file = join(cwd, 'not-executable');
    writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    const denied = await probeReadiness({
      source: 'cursor-cli',
      command: file,
      args: [],
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      killGraceMs: 50,
    });
    assert.equal(denied.errorCode, 'binary-not-executable');
    assert.equal(denied.availability, 'error');
    assert.equal((denied.detail ?? '').includes(file), false);
  });

  it('does not treat stderr 401 as auth failure when initialize succeeds', async () => {
    const cwd = tempDir();
    const trace = join(cwd, 'trace.txt');
    const script = join(cwd, 'stderr-401.mjs');
    writeFileSync(script, `import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const trace = process.argv[2];
process.stderr.write('notice 401 from the proxy\\n');
appendFileSync(trace, 'boot\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(trace, String(message.method) + '\\n');
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\\n');
  }
  if (message.method === 'session/new') {
    appendFileSync(trace, 'session-created\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'should-not' } }) + '\\n');
  }
});
`);
    const result = await probeReadiness({
      source: 'cursor-cli',
      command: process.execPath,
      args: [script, trace],
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      killGraceMs: 200,
    });
    const seen = readFileSync(trace, 'utf8');
    assert.equal(result.availability, 'unknown');
    assert.equal(result.errorCode, undefined);
    assert.equal(seen.includes('session/new'), false);
    assert.equal(seen.includes('initialize'), true);
  });

  it('classifies an incompatible protocol version before credentials', async () => {
    const calls: string[] = [];
    const result = await probeReadiness({
      source: 'codebuddy-cli',
      command: '/usr/local/bin/codebuddy',
      cwd: tempDir(),
      platform: 'darwin',
      epoch: EPOCH,
      apiKey: FAKE_KEY,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client(calls, {
        initialize: async () => {
          calls.push('initialize');
          return { protocolVersion: 2 };
        },
      }),
    });
    assert.equal(calls.includes('session/new'), false);
    assert.equal(calls.includes('close'), true);
    assert.equal(result.errorCode, 'unsupported-acp-version');
    assert.equal(result.availability, 'error');
    assert.equal((result.detail ?? '').includes(FAKE_KEY), false);
  });

  it('splits structured auth errors by the final child env key', async () => {
    const cwd = tempDir();
    const noKey = await probeReadiness({
      source: 'codebuddy-cli',
      command: '/usr/local/bin/codebuddy',
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me', AGENT_TOKEN: FAKE_KEY },
      open: () => authClient(`401 unauthorized ${FAKE_KEY} ${SECRET_PATH}`),
    });
    assert.equal(noKey.hasKey, false);
    assert.equal(noKey.errorCode, 'no-credential');
    assert.equal(noKey.availability, 'credential-required');
    assert.equal((noKey.detail ?? '').includes(FAKE_KEY), false);
    assert.equal((noKey.detail ?? '').includes(SECRET_PATH), false);

    const rejected = await probeReadiness({
      source: 'codebuddy-cli',
      command: '/usr/local/bin/codebuddy',
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      apiKey: FAKE_KEY,
      environment: 'ioa',
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me', AGENT_TOKEN: 'agent-token' },
      open: () => authClient(`403 forbidden ${FAKE_KEY} 凭据已验证`),
    });
    assert.equal(rejected.hasKey, true);
    assert.equal(rejected.errorCode, 'auth-rejected');
    assert.equal(rejected.availability, 'credential-required');
    const detail = rejected.detail ?? '';
    assert.equal(detail.includes(FAKE_KEY), false);
    assert.equal(detail.includes('凭据已验证'), false);
    assert.equal(JSON.stringify(rejected).includes(FAKE_KEY), false);
  });

  it('ignores 401 text on a non-auth rpc code and still classifies a real 401', async () => {
    const cwd = tempDir();
    const text = `notice 401 forbidden ${FAKE_KEY}`;
    const missed = await probeReadiness({
      source: 'codebuddy-cli',
      command: '/usr/local/bin/codebuddy',
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      apiKey: FAKE_KEY,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client([], {
        initialize: async () => {
          throw new JsonlRpcRemoteError(500, text);
        },
      }),
    });
    assert.equal(missed.errorCode, 'provider-error');
    assert.equal(missed.availability, 'error');
    assert.equal(JSON.stringify(missed).includes(FAKE_KEY), false);
    assert.equal(JSON.stringify(missed).includes('forbidden'), false);

    const noKey = await probeReadiness({
      source: 'codebuddy-cli',
      command: '/usr/local/bin/codebuddy',
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client([], {
        initialize: async () => {
          throw new JsonlRpcRemoteError(401, text);
        },
      }),
    });
    assert.equal(noKey.hasKey, false);
    assert.equal(noKey.errorCode, 'no-credential');
    assert.equal(noKey.availability, 'credential-required');

    const rejected = await probeReadiness({
      source: 'codebuddy-cli',
      command: '/usr/local/bin/codebuddy',
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      apiKey: FAKE_KEY,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client([], {
        initialize: async () => {
          throw new JsonlRpcRemoteError(401, text);
        },
      }),
    });
    assert.equal(rejected.hasKey, true);
    assert.equal(rejected.errorCode, 'auth-rejected');
    assert.equal(rejected.availability, 'credential-required');
    assert.equal(JSON.stringify(rejected).includes(FAKE_KEY), false);
  });

  it('starts one provider session and does not open a probe session', async () => {
    let opened = 0;
    const calls: string[] = [];
    const result = await startProviderSession({
      source: 'cursor-cli',
      command: '/usr/local/bin/cursor-agent',
      cwd: tempDir(),
      platform: 'darwin',
      epoch: EPOCH,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => {
        opened += 1;
        return client(calls, {
          initialize: async () => {
            calls.push('initialize');
            return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
          },
        });
      },
    });
    assert.equal(opened, 1);
    assert.equal(calls.filter(call => call === 'session/new').length, 1);
    assert.equal(calls.includes('cursor/list_available_models'), false);
    assert.equal(calls.includes('close'), false);
    assert.equal(result.ok, true);
    assert.equal(result.availability, 'ready');
    assert.equal((result.detail ?? '').includes('凭据已验证'), false);
  });

  it('reports cli:capabilities around probe and start with a monotonic checkedAt', async () => {
    const times = [100, 100, 50];
    let index = 0;
    const now = () => times[index++] ?? 0;
    const checkedAt: CheckedAtState = {};
    const reports: CliCapabilities[] = [];
    const emit = (event: string, payload: CliCapabilities) => {
      assert.equal(event, 'cli:capabilities');
      reports.push(payload);
    };
    const cwd = tempDir();
    await probeReadiness({
      source: 'cursor-cli',
      command: '/usr/local/bin/cursor-agent',
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      now,
      checkedAt,
      emit,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client([], {
        initialize: async () => ({ protocolVersion: 1 }),
      }),
    });
    await startProviderSession({
      source: 'cursor-cli',
      command: '/usr/local/bin/cursor-agent',
      cwd,
      platform: 'darwin',
      epoch: EPOCH,
      now,
      checkedAt,
      emit,
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client([], {
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      }),
    });
    assert.equal(reports.length, 3);
    assert.equal(reports[0]?.sources[0]?.availability, 'unknown');
    assert.equal(reports[1]?.sources[0]?.availability, 'unknown');
    assert.equal(reports[2]?.sources[0]?.availability, 'ready');
    assert.deepEqual(reports.map(report => report.sources[0]?.checkedAt), [100, 100, 100]);
    assert.equal(reports[2]?.platform, 'darwin');
    for (const report of reports)
      assert.equal((report.sources[0]?.detail ?? '').includes('凭据已验证'), false);
  });

  it('reports cli:capabilities after a failed start', async () => {
    const times = [10, 9];
    let index = 0;
    const reports: CliCapabilities[] = [];
    const calls: string[] = [];
    await startProviderSession({
      source: 'codebuddy-cli',
      command: '/usr/local/bin/codebuddy',
      cwd: tempDir(),
      platform: 'darwin',
      epoch: EPOCH,
      apiKey: FAKE_KEY,
      now: () => times[index++] ?? 0,
      checkedAt: {},
      emit: (event, payload) => {
        assert.equal(event, 'cli:capabilities');
        reports.push(payload);
      },
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      open: () => client(calls, {
        initialize: async () => {
          calls.push('initialize');
          throw new JsonlRpcRemoteError(401, `401 ${FAKE_KEY}`);
        },
      }),
    });
    assert.equal(calls.filter(call => call === 'session/new').length, 0);
    assert.equal(calls.includes('close'), true);
    assert.equal(reports.length, 2);
    assert.equal(reports[0]?.sources[0]?.availability, 'unknown');
    assert.equal(reports[1]?.sources[0]?.availability, 'credential-required');
    assert.equal((reports[1]?.sources[0]?.checkedAt ?? 0) >= (reports[0]?.sources[0]?.checkedAt ?? 0), true);
    assert.equal(JSON.stringify(reports).includes(FAKE_KEY), false);
  });

  it('builds a child env without lifeline secrets and reads hasKey from the result', () => {
    const cursor = buildChildEnv({
      source: 'cursor-cli',
      base: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        http_proxy: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'socks5://127.0.0.1:9',
        AGENT_TOKEN: 'agent-token',
        REMOTE_URL: 'https://lifeline.example',
        CODEBUDDY_API_KEY: FAKE_KEY,
        OTHER: 'keep-me',
      },
    });
    assert.equal(cursor.env.PATH, '/usr/bin:/bin');
    assert.equal(cursor.env.HOME, '/Users/me');
    assert.equal(cursor.env.http_proxy, 'http://127.0.0.1:9');
    assert.equal(cursor.env.https_proxy, 'http://127.0.0.1:9');
    assert.equal(cursor.env.HTTP_PROXY, 'http://127.0.0.1:9');
    assert.equal(cursor.env.HTTPS_PROXY, 'http://127.0.0.1:9');
    assert.equal(cursor.env.ALL_PROXY, 'socks5://127.0.0.1:9');
    assert.equal(cursor.env.OTHER, 'keep-me');
    assert.equal(cursor.env.AGENT_TOKEN, undefined);
    assert.equal(cursor.env.REMOTE_URL, undefined);
    assert.equal(cursor.env.CODEBUDDY_API_KEY, undefined);
    assert.equal(cursor.hasKey, false);

    const fromToken = buildChildEnv({
      source: 'codebuddy-cli',
      base: { PATH: '/bin', HOME: '/Users/me', AGENT_TOKEN: FAKE_KEY, REMOTE_URL: 'https://lifeline.example' },
    });
    assert.equal(fromToken.hasKey, false);
    assert.equal(fromToken.env.AGENT_TOKEN, undefined);
    assert.equal(fromToken.env.CODEBUDDY_API_KEY, undefined);

    const overlaid = buildChildEnv({
      source: 'codebuddy-cli',
      base: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        http_proxy: 'http://proxy',
        AGENT_TOKEN: 'agent-token',
        REMOTE_URL: 'https://lifeline.example',
      },
      apiKey: FAKE_KEY,
      environment: 'ioa',
    });
    assert.equal(overlaid.hasKey, true);
    assert.equal(overlaid.env.CODEBUDDY_API_KEY === FAKE_KEY, true);
    assert.equal(overlaid.env.CODEBUDDY_INTERNET_ENVIRONMENT, 'ioa');
    assert.equal(overlaid.env.AGENT_TOKEN, undefined);
    assert.equal(overlaid.env.REMOTE_URL, undefined);
    assert.equal(overlaid.env.PATH, '/usr/bin:/bin');
    assert.equal(overlaid.env.HOME, '/Users/me');
    assert.equal(overlaid.env.http_proxy, 'http://proxy');
  });

  it('spawns the saved absolute provider path under a minimal PATH', () => {
    const plan = planLaunchdProviderSpawn({
      source: 'cursor-cli',
      command: '/opt/homebrew/bin/cursor-agent',
      baseEnv: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/me',
        http_proxy: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'socks5://127.0.0.1:9',
        AGENT_TOKEN: 'agent-token',
        REMOTE_URL: 'https://lifeline.example',
      },
    });
    assert.deepEqual(plan.args, ['acp']);
    let command = '';
    let path = '';
    let sawToken = false;
    spawnAbsoluteProvider(plan, ((cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
      command = cmd;
      assert.deepEqual([...args], ['acp']);
      path = opts.env?.PATH ?? '';
      sawToken = opts.env?.AGENT_TOKEN != null || opts.env?.REMOTE_URL != null;
      return { unref() {} } as ChildProcess;
    }) as NonNullable<Parameters<typeof spawnAbsoluteProvider>[1]>);
    assert.equal(command, '/opt/homebrew/bin/cursor-agent');
    assert.equal(path, '/opt/homebrew/bin:/usr/bin:/bin');
    assert.equal(sawToken, false);

    const codebuddy = planLaunchdProviderSpawn({
      source: 'codebuddy-cli',
      command: '/opt/homebrew/bin/codebuddy',
      baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
      apiKey: FAKE_KEY,
      environment: 'ioa',
    });
    assert.deepEqual(codebuddy.args, ['--acp']);
    assert.equal(codebuddy.env.CODEBUDDY_API_KEY === FAKE_KEY, true);
    assert.equal(codebuddy.env.PATH, '/opt/homebrew/bin:/usr/bin:/bin');

    let message = '';
    let called = false;
    try {
      const relative = planLaunchdProviderSpawn({
        source: 'codebuddy-cli',
        command: 'codebuddy',
        baseEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/me' },
        apiKey: FAKE_KEY,
      });
      spawnAbsoluteProvider(relative, (() => {
        called = true;
        return { unref() {} } as ChildProcess;
      }) as NonNullable<Parameters<typeof spawnAbsoluteProvider>[1]>);
    }
    catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert.equal(called, false);
    assert.equal(message.includes('absolute'), true);
    assert.equal(message.includes(FAKE_KEY), false);
  });

  it('puts the shebang interpreter on PATH when a shim is linked away from its install', () => {
    const root = tempDir();
    const scriptDir = join(root, 'installation', 'lib', 'node_modules', '@openai', 'codex', 'bin');
    const nodeDir = join(root, 'installation', 'bin');
    const linkDir = join(root, 'local', 'bin');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    const script = join(scriptDir, 'codex.js');
    writeFileSync(script, '#!/usr/bin/env node\n');
    writeFileSync(join(nodeDir, 'node'), '');
    const link = join(linkDir, 'codex');
    symlinkSync(script, link);

    const env = withCliBinOnPath({ PATH: '/usr/bin:/bin' }, link);

    assert.equal(env.PATH, `${realpathSync(nodeDir)}:${linkDir}:/usr/bin:/bin`);
  });

  it('does not walk ancestors for a command that has no env shebang', () => {
    const root = tempDir();
    const bin = join(root, 'installation', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), '');
    const command = join(root, 'Vendor', 'codex');
    mkdirSync(join(root, 'Vendor'), { recursive: true });
    writeFileSync(command, '');

    const env = withCliBinOnPath({ PATH: '/usr/bin:/bin' }, command);

    assert.equal(env.PATH, `${join(root, 'Vendor')}:/usr/bin:/bin`);
  });
});

function client(calls: string[], overrides: Partial<ReadinessClient> = {}): ReadinessClient {
  return {
    start: async () => {
      calls.push('start');
    },
    initialize: async () => {
      calls.push('initialize');
      return { protocolVersion: 1 };
    },
    sessionNew: async () => {
      calls.push('session/new');
      return { sessionId: 'prov-1' };
    },
    close: async () => {
      calls.push('close');
    },
    ...overrides,
  };
}

function authClient(message: string): ReadinessClient {
  const calls: string[] = [];
  return client(calls, {
    initialize: async () => {
      throw new JsonlRpcRemoteError(401, message);
    },
  });
}
