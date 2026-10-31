import type { CliModelCatalog, CliModelChoice, CommandErrorCode } from '@lifeline/protocol';
import type { CliCatalogResult } from '../../cli-session-manager.js';
import { execFile } from 'node:child_process';
import { CATALOG_SERVE_MS, catalogFreshness, readStoredCatalog, writeStoredCatalog } from './catalog-disk.js';
import { parseCursorModelList } from './session-catalog.js';

const LIST_TIMEOUT_MS = 15_000;

interface CursorModelHit {
  command: string;
  at: number;
  result: CliCatalogResult;
}

export interface CursorModelMemory {
  cached?: CursorModelHit;
  pending?: { command: string; task: Promise<CliCatalogResult> };
}

export interface CursorModelListOptions {
  /** Last list on disk. A later process answers from it, then refreshes. */
  catalogPath?: string;
  now?: () => number;
  /** Tests pass their own memory. The process uses one shared cache. */
  memory?: CursorModelMemory;
}

const processMemory: CursorModelMemory = {};

/** Models from the last successful `cursor-agent --list-models`, while that list may still be served. */
export function peekCursorModels(): CliModelChoice[] | undefined {
  const hit = processMemory.cached;
  if (!hit?.result.ok || Date.now() - hit.at >= CATALOG_SERVE_MS)
    return undefined;
  return hit.result.data.catalog?.models;
}

/**
 * Account model list from `cursor-agent --list-models`.
 * One process at a time. A list saved in the last minute is reused. A list
 * younger than a day is returned at once and replaced in the background.
 */
export function listCursorModels(
  command: string,
  env: NodeJS.ProcessEnv,
  options?: CursorModelListOptions,
): Promise<CliCatalogResult> {
  const memory = options?.memory ?? processMemory;
  const now = options?.now?.() ?? Date.now();
  hydrateCursorModels(memory, command, options?.catalogPath);
  const hit = memory.cached?.command === command ? memory.cached : undefined;
  const freshness = hit ? catalogFreshness(hit.at, now) : 'miss';
  if (hit && freshness === 'fresh')
    return Promise.resolve(hit.result);
  if (hit && freshness === 'stale') {
    void refreshCursorModels(memory, command, env, options);
    return Promise.resolve(hit.result);
  }
  return refreshCursorModels(memory, command, env, options);
}

function hydrateCursorModels(memory: CursorModelMemory, command: string, catalogPath: string | undefined): void {
  if (memory.cached?.command === command || !catalogPath)
    return;
  const stored = readStoredCatalog(catalogPath, 'cursor-cli');
  if (!stored)
    return;
  memory.cached = {
    command,
    at: stored.at,
    result: { ok: true, data: { catalog: stored.catalog } },
  };
}

function refreshCursorModels(
  memory: CursorModelMemory,
  command: string,
  env: NodeJS.ProcessEnv,
  options: CursorModelListOptions | undefined,
): Promise<CliCatalogResult> {
  if (memory.pending?.command === command)
    return memory.pending.task;
  const task = runList(command, env).then((result) => {
    if (memory.pending?.task === task)
      memory.pending = undefined;
    const now = options?.now?.() ?? Date.now();
    const catalog = result.ok ? result.data.catalog : undefined;
    if (catalog && catalog.models.length > 0) {
      memory.cached = { command, at: now, result };
      rememberCursorModels(options?.catalogPath, now, catalog);
      return result;
    }
    const saved = memory.cached?.command === command ? memory.cached : undefined;
    if (saved && catalogFreshness(saved.at, now) === 'stale') {
      saved.at = now;
      const kept = saved.result.ok ? saved.result.data.catalog : undefined;
      if (kept)
        rememberCursorModels(options?.catalogPath, now, kept);
    }
    return result;
  });
  memory.pending = { command, task };
  return task;
}

function rememberCursorModels(catalogPath: string | undefined, at: number, catalog: CliModelCatalog): void {
  if (!catalogPath)
    return;
  try {
    writeStoredCatalog(catalogPath, 'cursor-cli', { at, catalog });
  }
  catch {
    // The dialog still has the list. The next process reads whatever was saved.
  }
}

function runList(command: string, env: NodeJS.ProcessEnv): Promise<CliCatalogResult> {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.AGENT_TOKEN;
  delete childEnv.REMOTE_URL;
  return new Promise((resolve) => {
    execFile(command, ['--list-models'], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: childEnv,
      windowsHide: true,
    }, (err, stdout) => {
      const catalog = parseCursorModelList(stdout ?? '');
      if (catalog) {
        resolve({ ok: true, data: { catalog } });
        return;
      }
      resolve({ ok: false, errorCode: listError(err) });
    });
  });
}

function listError(err: unknown): CommandErrorCode {
  const code = err != null && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  if (code === 'ENOENT')
    return 'binary-missing';
  if (code === 'EACCES')
    return 'binary-not-executable';
  const timedOut = err != null && typeof err === 'object' && 'killed' in err && err.killed === true;
  if (code === 'ETIMEDOUT' || timedOut)
    return 'provider-timeout';
  return 'provider-error';
}
