import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { loadBetterSqlite3 } from '../load-sqlite.js';
import * as schema from './schema.js';

export const LIFELINE_DB_FILE = 'lifeline.sqlite';

export type LifelineDb = BetterSQLite3Database<typeof schema>;

export function openSqlite(dbPath: string): Database.Database {
  const Database = loadBetterSqlite3();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { fileMustExist: false });
  db.pragma('journal_mode = WAL');
  applySchema(db);
  return db;
}

export function openDrizzle(dbPath: string): { sqlite: Database.Database; orm: LifelineDb } {
  const sqliteDb = openSqlite(dbPath);
  return { sqlite: sqliteDb, orm: drizzle(sqliteDb, { schema }) };
}

/** Ensure `data/` exists and return the path of `lifeline.sqlite`. Does not copy old files. */
export function bootstrapDataDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, LIFELINE_DB_FILE);
}

export function applySchema(db: Database.Database): void {
  migrateSessionsIdeColumn(db);
  migrateMachinesDisplayName(db);
  migrateMachinesPlatform(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    DROP TABLE IF EXISTS agent_tokens;

    CREATE TABLE IF NOT EXISTS machines (
      agent_id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      hostname TEXT NOT NULL,
      display_name TEXT,
      platform TEXT,
      cli_version TEXT,
      last_seen_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      snapshot_json TEXT
    );
    CREATE INDEX IF NOT EXISTS machines_owner ON machines (owner_user_id);

    CREATE TABLE IF NOT EXISTS machine_tokens (
      token_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS machine_tokens_agent ON machine_tokens (agent_id);

    -- Local credentials for the password provider (single-row table; this row does not exist when password login is unused).
    -- password_hash empty string = claim has not been completed / preset has not been persisted.
    CREATE TABLE IF NOT EXISTS auth_local (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password_hash TEXT NOT NULL,
      session_secret TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      agent_id TEXT NOT NULL,
      ide TEXT NOT NULL,
      session_id TEXT NOT NULL,
      meta_json TEXT NOT NULL,
      last_updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, ide, session_id)
    );
    -- findSessionOwners looks up content sources by (ide, session_id): the PK starts with agent_id so prefix match misses,
    -- and without this index it degrades to a full-table scan (2026-09-20 incident: 140k rows × 35ms, 30/s in a storm saturated one core).
    CREATE INDEX IF NOT EXISTS sessions_owner ON sessions (ide, session_id);

    CREATE TABLE IF NOT EXISTS messages (
      agent_id TEXT NOT NULL,
      ide TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      flat_index INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (agent_id, ide, session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS messages_order
      ON messages (agent_id, ide, session_id, flat_index);

    CREATE TABLE IF NOT EXISTS session_seq (
      agent_id TEXT NOT NULL,
      ide TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL,
      PRIMARY KEY (agent_id, ide, session_id)
    );
  `);
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}

/** `machines.display_name` (console rename) is a later-added column: old DBs created the table via CREATE TABLE IF NOT EXISTS without it, so ALTER once. */
function migrateMachinesDisplayName(db: Database.Database): void {
  if (!tableNames(db).has('machines'))
    return;
  if (columnNames(db, 'machines').has('display_name'))
    return;
  db.exec(`ALTER TABLE machines ADD COLUMN display_name TEXT`);
}

/**
 * `machines.platform` (OS the machine self-reports; the console uses it to emit commands for that machine) is also a later-added column.
 * ALTER once on old DBs; default NULL = never reported → the page falls back to its own OS toggle.
 */
function migrateMachinesPlatform(db: Database.Database): void {
  if (!tableNames(db).has('machines'))
    return;
  if (columnNames(db, 'machines').has('platform'))
    return;
  db.exec(`ALTER TABLE machines ADD COLUMN platform TEXT`);
}

/** Pre-ide sessions.sqlite: rebuild with ide='cursor'. */
function migrateSessionsIdeColumn(db: Database.Database): void {
  const names = tableNames(db);
  if (!names.has('sessions'))
    return;
  if (columnNames(db, 'sessions').has('ide'))
    return;
  db.exec(`
    ALTER TABLE sessions RENAME TO sessions_old;
    ${names.has('messages') ? 'ALTER TABLE messages RENAME TO messages_old;' : ''}
    CREATE TABLE sessions (
      agent_id TEXT NOT NULL,
      ide TEXT NOT NULL,
      session_id TEXT NOT NULL,
      meta_json TEXT NOT NULL,
      last_updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, ide, session_id)
    );
    CREATE TABLE messages (
      agent_id TEXT NOT NULL,
      ide TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      flat_index INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (agent_id, ide, session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS messages_order
      ON messages (agent_id, ide, session_id, flat_index);
    INSERT INTO sessions (agent_id, ide, session_id, meta_json, last_updated_at)
      SELECT agent_id, 'cursor', session_id, meta_json, last_updated_at FROM sessions_old;
    DROP TABLE sessions_old;
  `);
  if (names.has('messages')) {
    db.exec(`
      INSERT INTO messages (agent_id, ide, session_id, message_id, flat_index, payload)
        SELECT agent_id, 'cursor', session_id, message_id, flat_index, payload FROM messages_old;
      DROP TABLE messages_old;
    `);
  }
}
