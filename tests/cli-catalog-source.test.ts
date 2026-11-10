import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createLiveCliEntry } from '../packages/agent/src/drivers/acp/live-entry.js';

const EPOCH = '22222222-2222-4222-8222-222222222222';

function fakeClient() {
  return {
    async start() {},
    async initialize() {
      return { protocolVersion: 1 };
    },
    async sessionNew() {
      return { sessionId: 'prov-1' };
    },
    async prompt() {
      return { stopReason: 'end_turn' };
    },
    async cancel() {},
    async close() {},
  };
}

interface CatalogResult {
  ok: boolean;
  errorCode?: string;
  error?: string;
}

describe('command:cli_catalog source', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lifeline-catalog-'));
    dirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of dirs)
      rmSync(dir, { recursive: true, force: true });
  });

  async function readCatalog(source: 'codebuddy-cli' | 'codex-cli', cwd?: string) {
    const seenCommands: string[] = [];
    const results: CatalogResult[] = [];
    const entry = createLiveCliEntry({
      epoch: EPOCH,
      platform: 'linux',
      ledgerPath: join(tempDir(), 'ledger.json'),
      catalogPath: join(tempDir(), 'catalog.json'),
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/me',
        LIFELINE_CODEBUDDY_CLI: '/opt/codebuddy/bin/codebuddy',
        LIFELINE_CODEX_CLI: '/opt/codex/bin/codex',
      },
      apiKey: 'llk_fake_not_a_real_secret',
      emit: (event, payload) => {
        if (event === 'command:result')
          results.push(payload as CatalogResult);
      },
      construct: (options) => {
        seenCommands.push(options.command);
        return fakeClient();
      },
    });
    await entry.acceptCatalog({
      commandId: `catalog-${source}`,
      source,
      ...(cwd ? { cwd } : {}),
    });
    return { seenCommands, results };
  }

  it('reads the Codex catalog with the Codex client, not the CodeBuddy one', async () => {
    const { seenCommands, results } = await readCatalog('codex-cli', tempDir());
    assert.deepEqual(seenCommands, ['/opt/codex/bin/codex']);
    assert.deepEqual(results, [{ commandId: 'catalog-codex-cli', ok: true, data: {} }]);
  });

  it('still reads the CodeBuddy catalog with the CodeBuddy client', async () => {
    const { seenCommands, results } = await readCatalog('codebuddy-cli', tempDir());
    assert.deepEqual(seenCommands, ['/opt/codebuddy/bin/codebuddy']);
    assert.deepEqual(results, [{ commandId: 'catalog-codebuddy-cli', ok: true, data: {} }]);
  });

  it('rejects a catalog request without an absolute cwd', async () => {
    const { seenCommands, results } = await readCatalog('codex-cli');
    assert.deepEqual(seenCommands, []);
    assert.deepEqual(results, [{
      commandId: 'catalog-codex-cli',
      ok: false,
      errorCode: 'invalid-cwd',
      error: 'invalid-cwd',
    }]);
  });
});
