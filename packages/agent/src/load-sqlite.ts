import { createRequire as nodeCreateRequire } from 'node:module';
/**
 * Load better-sqlite3 without a top-level ESM import.
 *
 * The curl-installed CLI is a single file (typically ~/.local/bin/lifeline);
 * Node would not find a package imported from that path. Prefer the file's own
 * node_modules (npm -g / repo), then ~/.lifeline/runtime (bundled install),
 * then a plain sqlite-require.js beside it (left over from early installs; no longer written).
 *
 * If the native addon was compiled for a different Node (install.sh used PATH
 * npm; the daemon bakes process.execPath), rebuild once and retry when npm
 * exists next to that execPath.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSqliteAbiMismatch, rebuildBetterSqlite3, resolveNpmCli } from './ensure-sqlite.js';

type SqliteCtor = typeof import('better-sqlite3');

export function sqliteRequireBases(home: string = homedir()): string[] {
  return [
    import.meta.url,
    pathToFileURL(join(home, '.lifeline', 'runtime', 'lifeline.mjs')).href,
    pathToFileURL(join(home, '.lifeline', 'sqlite-require.js')).href,
  ];
}

export function formatMissingSqliteError(errors: string[]): string {
  return [
    'Cannot find package \'better-sqlite3\' (needed to read Cursor\'s chat database).',
    'Re-run the installer for your Lifeline server:',
    '  curl -fsSL http://<your-lifeline-server>/public/install.sh | sh',
    ...errors,
  ].join('\n');
}

function tryRequireBetterSqlite3(): { ctor?: SqliteCtor; errors: string[]; abi: boolean } {
  const errors: string[] = [];
  let abi = false;
  for (const base of sqliteRequireBases()) {
    try {
      return {
        ctor: nodeCreateRequire(base)('better-sqlite3') as SqliteCtor,
        errors,
        abi,
      };
    }
    catch (err) {
      errors.push(`${err instanceof Error ? err.message : String(err)}`);
      if (isSqliteAbiMismatch(err))
        abi = true;
    }
  }
  return { errors, abi };
}

function missingPackageError(errors: string[]): Error {
  return new Error(formatMissingSqliteError(errors));
}

export function loadBetterSqlite3(): SqliteCtor {
  let result = tryRequireBetterSqlite3();
  if (result.ctor)
    return result.ctor;
  if (result.abi && resolveNpmCli(process.execPath)) {
    try {
      rebuildBetterSqlite3(process.execPath, join(homedir(), '.lifeline'));
    }
    catch (err) {
      result.errors.push(
        `rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw missingPackageError(result.errors);
    }
    result = tryRequireBetterSqlite3();
    if (result.ctor)
      return result.ctor;
  }
  throw missingPackageError(result.errors);
}
