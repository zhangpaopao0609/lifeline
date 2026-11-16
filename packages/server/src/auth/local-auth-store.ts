import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { openSqlite } from '../db/open.js';

/**
 * `auth_local` single-row table (data/lifeline.sqlite): the session signing key.
 * `password_hash` is a leftover NOT NULL column. It is written as an empty string and never read.
 * Account passwords live in `auth_accounts`.
 * Connection is lazy (openSqlite only on first use) — loadConfig assembly does not touch disk;
 * IdentityStore holds a separate connection; they coexist under WAL.
 */
export class LocalAuthStore {
  private sqlite: Database.Database | null = null;

  constructor(private readonly dbPath: string) {}

  private db(): Database.Database {
    if (!this.sqlite)
      this.sqlite = openSqlite(this.dbPath);
    return this.sqlite;
  }

  close(): void {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }
  }

  private secret(): string | null {
    const raw = this.db().prepare('SELECT session_secret FROM auth_local WHERE id = 1').get();
    const row = raw as { session_secret: string } | undefined;
    return row?.session_secret ?? null;
  }

  /** Session signing key: generated once on first use, then stable (survives restart; no env required). */
  sessionSecret(): string {
    this.db()
      .prepare(
        `INSERT OR IGNORE INTO auth_local (id, password_hash, session_secret, updated_at)
         VALUES (1, '', ?, ?)`,
      )
      .run(randomBytes(32).toString('hex'), Date.now());
    return this.secret()!;
  }
}
