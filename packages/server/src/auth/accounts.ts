import type { ScryptOptions } from 'node:crypto';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { openSqlite } from '../db/open.js';

/** How many times scrypt actually ran. Tests use this to prove over-long passwords never reach it. */
let scryptCalls = 0;

export function scryptCallCount(): number {
  return scryptCalls;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  scryptCalls += 1;
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err)
        reject(err);
      else resolve(derivedKey);
    });
  });
}

/** OWASP scrypt (N=2^17). Node's default maxmem is 32MB, which rejects this N, so the ceiling is explicit. */
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SCRYPT_OPTIONS: ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM };

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD_LEN = 12;
const MAX_PASSWORD_LEN = 128;

const DUMMY_SALT = Buffer.alloc(SALT_LEN, 0x5A);
/** Fixed 32-byte value. The comparison result is discarded; it only keeps a missing user on the scrypt path. */
const DUMMY_HASH = Buffer.from(
  'c74682e55c4f3a7e8a57abf536203448612d0b456fe038d9aa527221996e03ce',
  'hex',
);

export const AUTH_ERRORS = {
  username: '用户名需要 3 到 32 位小写字母、数字、点、下划线或连字符，并以字母或数字开头。',
  passwordShort: '密码至少 12 位。',
  passwordLong: '密码不能超过 128 位。',
  passwordMismatch: '两次密码不一致。',
  passwordSame: '密码不能和用户名相同。',
  taken: '这个用户名已经有人使用。',
  login: '用户名或密码不正确。',
  closed: '注册已关闭。',
  limited: '尝试次数过多，请稍后再试。',
} as const;

/**
 * Trim, then ASCII lowercase only. No NFKC and no Unicode case fold:
 * `toLowerCase()` maps U+212A (Kelvin sign) to `k`, so any code point above 127 is rejected first.
 */
export function canonicalUsername(raw: string): string | null {
  const trimmed = raw.trim();
  for (const char of trimmed) {
    if ((char.codePointAt(0) ?? 0) > 127)
      return null;
  }
  const name = trimmed.toLowerCase();
  if (!USERNAME_RE.test(name))
    return null;
  return name;
}

export type PasswordProblem = 'long' | 'short' | 'same' | null;

/**
 * Reject before scrypt. Raw length is checked first so a multi-megabyte password never reaches NFKC or scrypt.
 * `username` is the already-canonical name.
 */
export function passwordProblem(raw: string, username: string): PasswordProblem {
  if (raw.length > MAX_PASSWORD_LEN)
    return 'long';
  const norm = raw.normalize('NFKC');
  if (norm.length > MAX_PASSWORD_LEN)
    return 'long';
  if (norm.length < MIN_PASSWORD_LEN)
    return 'short';
  if (norm === username)
    return 'same';
  return null;
}

export function passwordError(problem: Exclude<PasswordProblem, null>): string {
  if (problem === 'long')
    return AUTH_ERRORS.passwordLong;
  if (problem === 'short')
    return AUTH_ERRORS.passwordShort;
  return AUTH_ERRORS.passwordSame;
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(password.normalize('NFKC'), salt, KEY_LEN, SCRYPT_OPTIONS);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await derive(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Same work as a real check, then a comparison that does not match. */
export async function dummyPasswordCheck(password: string): Promise<void> {
  const actual = await derive(password, DUMMY_SALT);
  timingSafeEqual(actual, DUMMY_HASH);
}

/**
 * Verify a stored hash. Any parameter set other than the one we write is a mismatch and does not run scrypt,
 * so a row cannot ask for a larger N.
 */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt')
    return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4] ?? '';
  const hashHex = parts[5] ?? '';
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P)
    return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex))
    return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length !== SALT_LEN || expected.length !== KEY_LEN)
    return false;
  try {
    const actual = await derive(password, salt);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  catch {
    return false;
  }
}

export class AccountStore {
  private sqlite: ReturnType<typeof openSqlite> | null = null;

  constructor(private readonly dbPath: string) {}

  private db(): ReturnType<typeof openSqlite> {
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

  has(userId: string): boolean {
    const row = this.db().prepare('SELECT 1 AS ok FROM auth_accounts WHERE user_id = ?').get(userId) as { ok: number } | undefined;
    return !!row;
  }

  count(): number {
    const row = this.db().prepare('SELECT COUNT(*) AS n FROM auth_accounts').get() as { n: number };
    return row.n;
  }

  /** Insert. `taken` on primary-key conflict, including two concurrent registers of the same name. */
  async create(userId: string, password: string): Promise<'ok' | 'taken'> {
    const passwordHash = await hashPassword(password);
    try {
      this.db()
        .prepare('INSERT INTO auth_accounts (user_id, password_hash, created_at) VALUES (?, ?, ?)')
        .run(userId, passwordHash, Date.now());
      return 'ok';
    }
    catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      if (code.startsWith('SQLITE_CONSTRAINT'))
        return 'taken';
      throw err;
    }
  }

  /** Missing user still pays one scrypt. Stored hashes with unexpected parameters fail closed without scrypt. */
  async verify(userId: string | null, password: string): Promise<boolean> {
    if (!userId) {
      await dummyPasswordCheck(password);
      return false;
    }
    const row = this.db()
      .prepare('SELECT password_hash FROM auth_accounts WHERE user_id = ?')
      .get(userId) as { password_hash: string } | undefined;
    if (!row) {
      await dummyPasswordCheck(password);
      return false;
    }
    return verifyPasswordHash(password, row.password_hash);
  }
}
