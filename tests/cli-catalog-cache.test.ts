import type { CliModelCatalog } from '@lifeline/protocol';
import type { CatalogStorage } from '../packages/web/src/lib/cli-catalog-cache.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogFromStored, readCliCatalog, writeCliCatalog } from '../packages/web/src/lib/cli-catalog-cache.ts';

function memoryStorage(): CatalogStorage & { dump: () => Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump: () => dump,
    getItem: key => dump.get(key) ?? null,
    setItem: (key, value) => {
      dump.set(key, value);
    },
  };
}

const cursorList: CliModelCatalog = {
  currentModelId: 'grok-4.7-low',
  models: [
    { id: 'grok-4.7-low', label: 'Grok 4.7 Low' },
    { id: 'grok-4.7-high-fast', label: 'Grok 4.7 High Fast' },
  ],
};

describe('cli catalog cache', () => {
  it('shows the last list again after the page memory is gone', () => {
    const storage = memoryStorage();
    const openPage = new Map<string, CliModelCatalog>();
    writeCliCatalog('cursor-cli', cursorList, openPage, storage);

    const refreshed = new Map<string, CliModelCatalog>();
    assert.deepEqual(readCliCatalog('cursor-cli', refreshed, storage), cursorList);
    assert.equal(readCliCatalog('codebuddy-cli', refreshed, storage), undefined);
  });

  it('keeps the list for this page when storage cannot be written', () => {
    const storage: CatalogStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    const page = new Map<string, CliModelCatalog>();
    writeCliCatalog('cursor-cli', cursorList, page, storage);
    assert.deepEqual(readCliCatalog('cursor-cli', page, storage), cursorList);
  });

  it('drops a stored list that is not a catalog', () => {
    assert.equal(catalogFromStored(null), undefined);
    assert.equal(catalogFromStored({ models: [] }), undefined);
    assert.equal(catalogFromStored({ models: [{ id: '', label: 'Auto' }] }), undefined);
    assert.deepEqual(catalogFromStored({
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', thinking: { levels: [{ value: 'low', label: 'Low' }], current: 'low' } }],
      thinking: { levels: [{ value: 'max', label: 'Max' }] },
    }), {
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', thinking: { levels: [{ value: 'low', label: 'Low' }], current: 'low' } }],
      thinking: { levels: [{ value: 'max', label: 'Max' }] },
    });
  });
});
