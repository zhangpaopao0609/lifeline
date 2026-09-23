import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getDefaultSelectors } from '../packages/agent/src/config.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The installed daemon runs with cwd `/`, so `loadSelectors()` cannot reach the
 * repo's `selectors.json` and `getDefaultSelectors()` becomes the effective
 * config in production. Keeping the two in sync is not cosmetic: a missing
 * `modelDropdown` here silently broke the web model picker for every daemon
 * install while working fine when run from the repo.
 */
describe('getDefaultSelectors parity with selectors.json', () => {
  const fromFile = JSON.parse(
    readFileSync(join(ROOT, '../packages/agent/selectors.json'), 'utf-8'),
  ) as Record<string, unknown>;

  it('matches selectors.json exactly', () => {
    assert.deepEqual(getDefaultSelectors(), fromFile);
  });

  it('keeps the composer model dropdown wired up', () => {
    const strategies = getDefaultSelectors().modelDropdown?.strategies ?? [];
    assert.ok(strategies.length > 0, 'modelDropdown must not be empty — the daemon relies on it');
    assert.ok(strategies.includes('.vscode-model-picker__trigger'), 'current Cursor trigger missing');
  });
});
