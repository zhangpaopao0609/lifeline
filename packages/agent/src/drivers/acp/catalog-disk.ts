import type { CliModelCatalog, CliModelChoice, CliSource, CliThinkingLevel } from '@lifeline/protocol';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLI_SOURCES } from '@lifeline/protocol';

/**
 * How long a saved list is answered as-is. Past this, opening the dialog also
 * starts a background read. The next open picks up that read.
 */
export const CATALOG_REVALIDATE_MS = 60 * 1000;

/**
 * How long a saved list may answer at all. A day matches a CLI upgrade, not a
 * page load. Past this the dialog waits for a new read.
 */
export const CATALOG_SERVE_MS = 24 * 60 * 60 * 1000;

export interface StoredCatalog {
  at: number;
  catalog: CliModelCatalog;
}

export function cliCatalogPath(home: string = homedir()): string {
  return join(home, '.lifeline', 'cli-catalogs.json');
}

export function catalogFreshness(at: number, now: number): 'fresh' | 'stale' | 'miss' {
  const age = now - at;
  if (age < CATALOG_REVALIDATE_MS)
    return 'fresh';
  if (age < CATALOG_SERVE_MS)
    return 'stale';
  return 'miss';
}

export function readStoredCatalog(path: string, source: CliSource): StoredCatalog | undefined {
  const row = readFile(path)[source];
  if (!row)
    return undefined;
  return row;
}

export function writeStoredCatalog(path: string, source: CliSource, stored: StoredCatalog): void {
  const rows = readFile(path);
  rows[source] = { at: stored.at, catalog: stored.catalog };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ sources: rows })}\n`, 'utf8');
}

function readFile(path: string): Partial<Record<CliSource, StoredCatalog>> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  }
  catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  }
  catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.sources))
    return {};
  const rows: Partial<Record<CliSource, StoredCatalog>> = {};
  for (const source of CLI_SOURCES) {
    const row = readRow(parsed.sources[source]);
    if (row)
      rows[source] = row;
  }
  return rows;
}

function readRow(value: unknown): StoredCatalog | undefined {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at))
    return undefined;
  const catalog = readCatalog(value.catalog);
  if (!catalog)
    return undefined;
  return { at: value.at, catalog };
}

function readCatalog(value: unknown): CliModelCatalog | undefined {
  if (!isRecord(value) || !Array.isArray(value.models) || value.models.length === 0)
    return undefined;
  const models: CliModelChoice[] = [];
  for (const item of value.models) {
    const model = readModel(item);
    if (!model)
      return undefined;
    models.push(model);
  }
  const catalog: CliModelCatalog = { models };
  if (typeof value.currentModelId === 'string' && value.currentModelId.length > 0)
    catalog.currentModelId = value.currentModelId;
  const thinking = readThinking(value.thinking);
  if (thinking)
    catalog.thinking = thinking;
  return catalog;
}

function readModel(value: unknown): CliModelChoice | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || typeof value.label !== 'string')
    return undefined;
  const model: CliModelChoice = { id: value.id, label: value.label };
  const thinking = readThinking(value.thinking);
  if (thinking)
    model.thinking = thinking;
  return model;
}

function readThinking(value: unknown): CliModelChoice['thinking'] | undefined {
  if (!isRecord(value) || !Array.isArray(value.levels) || value.levels.length === 0)
    return undefined;
  const levels: CliThinkingLevel[] = [];
  for (const level of value.levels) {
    if (!isRecord(level) || typeof level.value !== 'string' || level.value.length === 0 || typeof level.label !== 'string')
      return undefined;
    levels.push({ value: level.value, label: level.label });
  }
  const thinking: NonNullable<CliModelChoice['thinking']> = { levels };
  if (typeof value.current === 'string' && value.current.length > 0)
    thinking.current = value.current;
  return thinking;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
