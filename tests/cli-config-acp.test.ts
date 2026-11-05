import type { CliConfig } from '../packages/cli/src/config.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { agentRuntimeEnv } from '../packages/cli/src/commands/start.js';
import { codebuddyProviderEnv, readCliConfigFile, withPersistedCliProviders, writeCliConfigFile } from '../packages/cli/src/config.js';

const FAKE_KEY = 'llk_fake_not_a_real_secret';

function baseConfig(extra: Record<string, unknown> = {}): CliConfig {
  return {
    serverUrl: 'https://lifeline.example',
    agentToken: 'token-1',
    cdpUrl: 'http://127.0.0.1:9222',
    pollIntervalMs: 500,
    debounceMs: 300,
    ...extra,
  };
}

describe('cli acp config', () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs)
      rmSync(dir, { recursive: true, force: true });
  });

  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lifeline-cli-config-'));
    dirs.push(dir);
    return join(dir, 'config.json');
  }

  it('persists absolute provider paths, the codebuddy key and environment, and keeps unknown fields', () => {
    const file = tempFile();
    writeFileSync(file, `${JSON.stringify({
      serverUrl: 'https://lifeline.example',
      agentToken: 'token-1',
      customRollout: { enabled: true },
      note: 'keep-me',
    }, null, 2)}\n`);

    const loaded = readCliConfigFile(file);
    assert.ok(loaded);
    assert.equal((loaded as { note?: string }).note, 'keep-me');
    assert.equal((loaded as { customRollout?: { enabled?: boolean } }).customRollout?.enabled, true);

    writeCliConfigFile({
      ...loaded,
      cursorCliPath: '/usr/local/bin/cursor-agent',
      codebuddyCliPath: '/usr/local/bin/codebuddy',
      codebuddyApiKey: FAKE_KEY,
      codebuddyInternetEnvironment: 'ioa',
    }, file);

    assert.equal(statSync(file).mode & 0o777, 0o600);
    const dir = join(file, '..');
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), []);

    const raw = readFileSync(file, 'utf8');
    assert.equal(raw.includes(FAKE_KEY), true);
    assert.equal(raw.includes('keep-me'), true);
    assert.equal(raw.includes('"/usr/local/bin/cursor-agent"'), true);
    assert.equal(raw.includes('"/usr/local/bin/codebuddy"'), true);
    assert.equal(raw.includes('"codebuddyInternetEnvironment": "ioa"'), true);
    assert.equal(raw.includes('"enabled": true'), true);

    const again = readCliConfigFile(file);
    assert.equal(again?.cursorCliPath, '/usr/local/bin/cursor-agent');
    assert.equal(again?.codebuddyCliPath, '/usr/local/bin/codebuddy');
    assert.equal(again?.codebuddyInternetEnvironment, 'ioa');
    assert.equal(again?.codebuddyApiKey === FAKE_KEY, true);
    assert.equal((again as { note?: string }).note, 'keep-me');
    assert.equal((again as { customRollout?: { enabled?: boolean } }).customRollout?.enabled, true);
  });

  it('rejects a relative provider path and the error text does not contain the key', () => {
    const file = tempFile();
    writeCliConfigFile(baseConfig({
      cursorCliPath: '/usr/local/bin/cursor-agent',
      note: 'keep-me',
    }), file);

    let message = '';
    try {
      writeCliConfigFile(baseConfig({
        codebuddyCliPath: 'codebuddy',
        codebuddyApiKey: FAKE_KEY,
        note: 'keep-me',
      }), file);
    }
    catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert.equal(message.includes('absolute'), true);
    assert.equal(message.includes(FAKE_KEY), false);
    const raw = readFileSync(file, 'utf8');
    assert.equal(raw.includes('"codebuddyCliPath": "codebuddy"'), false);
    assert.equal(raw.includes('keep-me'), true);
  });

  it('drops a relative provider path on load and still keeps unknown fields', () => {
    const file = tempFile();
    writeFileSync(file, `${JSON.stringify({
      serverUrl: 'https://lifeline.example',
      agentToken: 'token-1',
      cursorCliPath: 'cursor-agent',
      note: 'keep-me',
    })}\n`);
    const loaded = readCliConfigFile(file);
    assert.ok(loaded);
    assert.equal(loaded.cursorCliPath, undefined);
    assert.equal(JSON.stringify(loaded).includes('cursor-agent'), false);
    assert.equal((loaded as { note?: string }).note, 'keep-me');
  });

  it('keeps absolute provider paths and the codebuddy key when setup rebuilds a config', () => {
    const file = tempFile();
    const otherKey = 'llk_other_placeholder';
    let thrown = '';
    const saved = withPersistedCliProviders({
      config: baseConfig(),
      existing: baseConfig({
        cursorCliPath: '/usr/local/bin/cursor-agent',
        codebuddyApiKey: otherKey,
        codebuddyInternetEnvironment: 'ioa',
      }),
      lookup: (source) => {
        if (source === 'cursor-cli')
          return '/opt/other/cursor-agent';
        if (source === 'codebuddy-cli')
          return '/opt/homebrew/bin/codebuddy';
        return 'codebuddy';
      },
      codebuddyApiKey: FAKE_KEY,
    });
    try {
      writeCliConfigFile(saved, file);
    }
    catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    assert.equal(thrown.includes(FAKE_KEY), false);
    assert.equal(thrown.includes(otherKey), false);
    const raw = readFileSync(file, 'utf8');
    assert.equal(raw.includes(FAKE_KEY), true);
    assert.equal(raw.includes(otherKey), false);
    assert.equal(raw.includes('"/usr/local/bin/cursor-agent"'), true);
    assert.equal(raw.includes('"/opt/homebrew/bin/codebuddy"'), true);
    assert.equal(raw.includes('"codebuddyInternetEnvironment": "ioa"'), true);
    assert.equal(saved.codebuddyApiKey === FAKE_KEY, true);

    const relative = withPersistedCliProviders({
      config: baseConfig(),
      existing: baseConfig({ codebuddyCliPath: 'codebuddy' }),
      lookup: () => 'cursor-agent',
    });
    assert.equal(relative.cursorCliPath, undefined);
    assert.equal(relative.codebuddyCliPath, undefined);

    const fromExisting = withPersistedCliProviders({
      config: baseConfig(),
      existing: baseConfig({
        codebuddyApiKey: FAKE_KEY,
        codebuddyInternetEnvironment: 'internal',
      }),
    });
    assert.equal(fromExisting.codebuddyApiKey === FAKE_KEY, true);
    assert.equal(fromExisting.codebuddyInternetEnvironment, 'internal');
  });

  it('copies a non-empty CodeBuddy setup env into the config file', () => {
    const file = tempFile();
    const logged: string[] = [];
    const methods = ['log', 'info', 'warn', 'error'] as const;
    const previous = methods.map(method => console[method]);
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        logged.push(args.map(arg => typeof arg === 'string' ? arg : '').join(' '));
      };
    }
    const given = {
      CODEBUDDY_API_KEY: FAKE_KEY,
      CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa',
      PATH: '/usr/bin',
    };
    let thrown = '';
    try {
      const saved = withPersistedCliProviders({
        config: baseConfig(),
        existing: baseConfig(),
        ...codebuddyProviderEnv(given),
      });
      try {
        writeCliConfigFile(saved, file);
      }
      catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      }
      const blank = codebuddyProviderEnv({
        CODEBUDDY_API_KEY: '',
        CODEBUDDY_INTERNET_ENVIRONMENT: '',
      });
      assert.equal(blank.codebuddyApiKey, undefined);
      assert.equal(blank.codebuddyInternetEnvironment, undefined);
      const kept = withPersistedCliProviders({
        config: baseConfig(),
        existing: baseConfig({
          codebuddyApiKey: FAKE_KEY,
          codebuddyInternetEnvironment: 'internal',
        }),
        ...blank,
      });
      assert.equal(kept.codebuddyApiKey === FAKE_KEY, true);
      assert.equal(kept.codebuddyInternetEnvironment, 'internal');
      assert.equal(thrown.includes(FAKE_KEY), false);
      assert.equal(logged.join('\n').includes(FAKE_KEY), false);
      const raw = readFileSync(file, 'utf8');
      assert.equal(raw.includes(FAKE_KEY), true);
      assert.equal(raw.includes('"codebuddyInternetEnvironment": "ioa"'), true);
      const setup = readFileSync(new URL('../packages/cli/src/commands/setup.ts', import.meta.url), 'utf8');
      const calls = setup.match(/codebuddyProviderEnv\(process\.env\)/g) ?? [];
      assert.equal(calls.length, 2);
    }
    finally {
      for (let index = 0; index < methods.length; index += 1)
        console[methods[index]!] = previous[index]!;
    }
  });

  it('keeps the codebuddy key out of the agent process env', () => {
    const env = agentRuntimeEnv(baseConfig({
      cursorCliPath: '/usr/local/bin/cursor-agent',
      codebuddyCliPath: '/usr/local/bin/codebuddy',
      codebuddyApiKey: FAKE_KEY,
      codebuddyInternetEnvironment: 'ioa',
    }), {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      CODEBUDDY_API_KEY: FAKE_KEY,
      CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa',
    });
    assert.equal(env.AGENT_TOKEN, 'token-1');
    assert.equal(env.REMOTE_URL, 'https://lifeline.example');
    assert.equal(env.CDP_URL, 'http://127.0.0.1:9222');
    assert.equal(env.LIFELINE_CURSOR_CLI, '/usr/local/bin/cursor-agent');
    assert.equal(env.LIFELINE_CODEBUDDY_CLI, '/usr/local/bin/codebuddy');
    assert.equal('CODEBUDDY_API_KEY' in env, false);
    assert.equal('CODEBUDDY_INTERNET_ENVIRONMENT' in env, false);
    assert.equal(JSON.stringify(env).includes(FAKE_KEY), false);

    const relative = agentRuntimeEnv(baseConfig({
      cursorCliPath: 'cursor-agent',
      codebuddyApiKey: FAKE_KEY,
    }), { PATH: '/usr/bin:/bin' });
    assert.equal(relative.LIFELINE_CURSOR_CLI, undefined);
    assert.equal(JSON.stringify(relative).includes(FAKE_KEY), false);
  });

  it('persists codexCliPath, finds codex on PATH at setup, and forwards it to the agent', () => {
    const file = tempFile();
    writeFileSync(file, `${JSON.stringify({ serverUrl: 'https://lifeline.example', agentToken: 'token-1' })}\n`);
    const loaded = readCliConfigFile(file);
    assert.ok(loaded);
    writeCliConfigFile({ ...loaded, codexCliPath: '/home/me/.local/bin/my-codex' }, file);
    assert.equal(readCliConfigFile(file)?.codexCliPath, '/home/me/.local/bin/my-codex');
    assert.throws(() => writeCliConfigFile({ ...loaded, codexCliPath: 'codex' }, file));

    const rebuilt = withPersistedCliProviders({
      config: baseConfig({}),
      existing: null,
      lookup: source => (source === 'codex-cli' ? '/usr/local/bin/codex' : undefined),
    });
    assert.equal(rebuilt.codexCliPath, '/usr/local/bin/codex');
    const kept = withPersistedCliProviders({
      config: baseConfig({}),
      existing: baseConfig({ codexCliPath: '/home/me/.local/bin/my-codex' }),
      lookup: () => '/usr/local/bin/codex',
    });
    assert.equal(kept.codexCliPath, '/home/me/.local/bin/my-codex');

    assert.equal(agentRuntimeEnv(baseConfig({ codexCliPath: '/usr/local/bin/codex' }), {}).LIFELINE_CODEX_CLI, '/usr/local/bin/codex');
    assert.equal('LIFELINE_CODEX_CLI' in agentRuntimeEnv(baseConfig({}), { LIFELINE_CODEX_CLI: '/stale' }), false);
  });
});
