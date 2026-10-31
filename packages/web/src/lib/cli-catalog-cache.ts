import type { CliModelCatalog, CliModelChoice, CliThinkingLevel } from '../net/protocol';

/**
 * The new-session dialog shows the last model list at once, then asks the
 * machine for a new one. The map lives only as long as this page. sessionStorage
 * keeps that list across a refresh, which is the usual way back into the console.
 */
const STORAGE_PREFIX = 'll:cli-catalog:';

export interface CatalogStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function readCliCatalog(
  source: string,
  memory: Map<string, CliModelCatalog>,
  storage: CatalogStorage | undefined,
): CliModelCatalog | undefined {
  const remembered = memory.get(source);
  if (remembered)
    return remembered;
  const stored = readStoredCatalog(source, storage);
  if (!stored)
    return undefined;
  memory.set(source, stored);
  return stored;
}

export function writeCliCatalog(
  source: string,
  catalog: CliModelCatalog,
  memory: Map<string, CliModelCatalog>,
  storage: CatalogStorage | undefined,
): void {
  memory.set(source, catalog);
  if (!storage)
    return;
  try {
    storage.setItem(STORAGE_PREFIX + source, JSON.stringify(catalog));
  }
  catch {
    // Private mode or a full quota: this page still has the list in memory.
  }
}

function readStoredCatalog(source: string, storage: CatalogStorage | undefined): CliModelCatalog | undefined {
  if (!storage)
    return undefined;
  try {
    const raw = storage.getItem(STORAGE_PREFIX + source);
    if (!raw)
      return undefined;
    return catalogFromStored(JSON.parse(raw));
  }
  catch {
    return undefined;
  }
}

export function catalogFromStored(value: unknown): CliModelCatalog | undefined {
  if (value == null || typeof value !== 'object')
    return undefined;
  const record = value as { models?: unknown; currentModelId?: unknown; thinking?: unknown };
  if (!Array.isArray(record.models) || record.models.length === 0)
    return undefined;
  const models: CliModelChoice[] = [];
  for (const item of record.models) {
    const model = modelFromStored(item);
    if (!model)
      return undefined;
    models.push(model);
  }
  const catalog: CliModelCatalog = { models };
  if (typeof record.currentModelId === 'string' && record.currentModelId.length > 0)
    catalog.currentModelId = record.currentModelId;
  const thinking = thinkingFromStored(record.thinking);
  if (thinking)
    catalog.thinking = thinking;
  return catalog;
}

function modelFromStored(value: unknown): CliModelChoice | undefined {
  if (value == null || typeof value !== 'object')
    return undefined;
  const row = value as { id?: unknown; label?: unknown; thinking?: unknown };
  if (typeof row.id !== 'string' || row.id.length === 0 || typeof row.label !== 'string')
    return undefined;
  const thinking = thinkingFromStored(row.thinking);
  return {
    id: row.id,
    label: row.label,
    ...(thinking ? { thinking } : {}),
  };
}

function thinkingFromStored(value: unknown): { levels: CliThinkingLevel[]; current?: string } | undefined {
  if (value == null || typeof value !== 'object')
    return undefined;
  const record = value as { levels?: unknown; current?: unknown };
  if (!Array.isArray(record.levels) || record.levels.length === 0)
    return undefined;
  const levels: CliThinkingLevel[] = [];
  for (const item of record.levels) {
    if (item == null || typeof item !== 'object')
      return undefined;
    const row = item as { value?: unknown; label?: unknown };
    if (typeof row.value !== 'string' || typeof row.label !== 'string')
      return undefined;
    levels.push({ value: row.value, label: row.label });
  }
  return {
    levels,
    ...(typeof record.current === 'string' ? { current: record.current } : {}),
  };
}
