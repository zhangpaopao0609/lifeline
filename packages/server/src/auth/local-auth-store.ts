import type Database from 'better-sqlite3';
import type { ScryptOptions } from 'node:crypto';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { openSqlite } from '../db/open.js';

/** Async scrypt (spec: ban scryptSync blocking the event loop). Hand-rolled wrapper: promisify cannot pick the overload with options. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err)
        reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Hard-coded scrypt parameters (spec: ban scryptSync; parameters go into the stored string so they can be tuned later). */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/**
 * `auth_local` single-row table (data/lifeline.sqlite): password_hash + session_secret.
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

  private row(): { password_hash: string; session_secret: string } | null {
    const raw = this.db().prepare('SELECT password_hash, session_secret FROM auth_local WHERE id = 1').get();
    return (raw as { password_hash: string; session_secret: string } | undefined) ?? null;
  }

  /** Whether a password has been set (empty string = claim not completed / preset not persisted). */
  hasPassword(): boolean {
    const r = this.row();
    return !!r && r.password_hash !== '';
  }

  /** Session signing key: generated once on first use, then stable (survives restart; no env required). */
  sessionSecret(): string {
    this.db()
      .prepare(
        `INSERT OR IGNORE INTO auth_local (id, password_hash, session_secret, updated_at)
         VALUES (1, '', ?, ?)`,
      )
      .run(randomBytes(32).toString('hex'), Date.now());
    return this.row()!.session_secret;
  }

  async setPassword(password: string): Promise<void> {
    this.sessionSecret(); // ensure the row exists
    const saltHex = randomBytes(SALT_LEN).toString('hex');
    const hash = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    this.db()
      .prepare('UPDATE auth_local SET password_hash = ?, updated_at = ? WHERE id = 1')
      .run(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${hash.toString('hex')}`, Date.now());
  }

  /** Verify a password (parameters read back from the stored string, matching those used at setPassword time). */
  async verifyPassword(password: string): Promise<boolean> {
    const r = this.row();
    if (!r || r.password_hash === '')
      return false;
    const parts = r.password_hash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt')
      return false;
    const n = Number(parts[1]);
    const rr = Number(parts[2]);
    const p = Number(parts[3]);
    const saltHex = parts[4];
    const hashHex = parts[5];
    if (!Number.isInteger(n) || !Number.isInteger(rr) || !Number.isInteger(p))
      return false;
    if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex))
      return false;
    try {
      const expected = Buffer.from(hashHex, 'hex');
      const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), expected.length, {
        N: n,
        r: rr,
        p,
      });
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    catch {
      return false;
    }
  }
}
