import { createRequire } from 'node:module';

type SqliteCtor = typeof import('better-sqlite3');

/** Server process always has node_modules next to the package. */
export function loadBetterSqlite3(): SqliteCtor {
  return createRequire(import.meta.url)('better-sqlite3') as SqliteCtor;
}
