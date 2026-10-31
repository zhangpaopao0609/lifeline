import type { CliModelCatalog } from '@lifeline/protocol';
import type { CursorModelMemory } from '../packages/agent/src/drivers/acp/cursor-models.js';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CATALOG_REVALIDATE_MS, CATALOG_SERVE_MS, catalogFreshness, readStoredCatalog, writeStoredCatalog } from '../packages/agent/src/drivers/acp/catalog-disk.js';
import { listCursorModels } from '../packages/agent/src/drivers/acp/cursor-models.js';

const codebuddy: CliModelCatalog = {
  models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
  currentModelId: 'glm-5.2',
};

describe('cli catalog disk', () => {
  it('keeps each agent list in one file', () => {
    return withDir(async (dir) => {
      const file = path.join(dir, 'cli-catalogs.json');
      writeStoredCatalog(file, 'codebuddy-cli', { at: 10, catalog: codebuddy });
      writeStoredCatalog(file, 'cursor-cli', {
        at: 20,
        catalog: { models: [{ id: 'auto', label: 'Auto' }], currentModelId: 'auto' },
      });
      assert.equal(readStoredCatalog(file, 'codebuddy-cli')?.at, 10);
      assert.equal(readStoredCatalog(file, 'cursor-cli')?.catalog.currentModelId, 'auto');
      assert.equal(catalogFreshness(10, 10 + CATALOG_REVALIDATE_MS - 1), 'fresh');
      assert.equal(catalogFreshness(10, 10 + CATALOG_REVALIDATE_MS), 'stale');
      assert.equal(catalogFreshness(10, 10 + CATALOG_SERVE_MS), 'miss');
    });
  });

  it('a later process answers from the saved Cursor list', () => {
    return withDir(async (dir) => {
      const bin = path.join(dir, 'cursor-agent');
      const log = path.join(dir, 'runs');
      const catalogPath = path.join(dir, 'cli-catalogs.json');
      await writeFile(bin, `#!/bin/sh\necho ran >> ${shellQuote(log)}\necho 'auto - Auto (current)'\n`);
      await chmod(bin, 0o755);
      let now = 1_000_000;
      const firstMemory: CursorModelMemory = {};
      const first = await listCursorModels(bin, { PATH: process.env.PATH }, {
        catalogPath,
        memory: firstMemory,
        now: () => now,
      });
      assert.equal(first.ok, true);
      if (first.ok)
        assert.equal(first.data.catalog?.currentModelId, 'auto');
      assert.equal(await runCount(log), 1);

      now += 30_000;
      const restarted: CursorModelMemory = {};
      const second = await listCursorModels(bin, { PATH: process.env.PATH }, {
        catalogPath,
        memory: restarted,
        now: () => now,
      });
      assert.equal(second.ok, true);
      if (second.ok)
        assert.equal(second.data.catalog?.models[0]?.id, 'auto');
      assert.equal(await runCount(log), 1);

      now += CATALOG_REVALIDATE_MS;
      const later: CursorModelMemory = {};
      const third = await listCursorModels(bin, { PATH: process.env.PATH }, {
        catalogPath,
        memory: later,
        now: () => now,
      });
      assert.equal(third.ok, true);
      if (third.ok)
        assert.equal(third.data.catalog?.currentModelId, 'auto');
      await waitForRuns(log, 2);
    });
  });
});

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'll-catalog-'));
  await run(dir);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', `'\\''`)}'`;
}

async function runCount(log: string): Promise<number> {
  try {
    const text = await readFile(log, 'utf8');
    return text.trim().split('\n').filter(line => line.length > 0).length;
  }
  catch {
    return 0;
  }
}

async function waitForRuns(log: string, count: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (await runCount(log) >= count)
      return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await runCount(log), count);
}
