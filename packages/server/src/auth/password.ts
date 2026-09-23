import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { AvatarUrlFor } from './avatar.js';
import type { AuthProvider, VerifiedIdentity } from './provider.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GENERIC_FORBIDDEN_HTML } from '../pages/forbidden-page.js';
import { NO_AVATAR } from './avatar.js';
import { LocalAuthStore } from './local-auth-store.js';
import { checkOriginAgainstExpected, headerString } from './origin.js';
import { CLAIM_HTML, LOGIN_HTML } from './password-pages.js';

const COOKIE_NAME = 'lifeline_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Claim-code entropy (spec frozen): 32B hex = 256 bit; a short code + rate limit still cannot withstand remote guessing. */
const CLAIM_TTL_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LEN = 8;
/** Same tier for /api/claim and /api/login: code guessing and password stuffing share 5 failures/minute/IP. */
const RATE_MAX_FAILURES = 5;
const RATE_WINDOW_MS = 60 * 1000;

// --------------------------------------------------------------------- cookie

export function signSessionPayload(secret: string, userId: string, expiresAtMs: number): string {
  return createHmac('sha256', secret).update(`v1|${userId}|${expiresAtMs}`).digest('hex');
}

export function buildSessionCookie(userId: string, expiresAtMs: number, secret: string): string {
  return `v1|${userId}|${expiresAtMs}|${signSessionPayload(secret, userId, expiresAtMs)}`;
}

/** Reject on bad signature, expiry, or tampering; comparison uses timingSafeEqual (lengths aligned first). */
export function parseSessionCookie(value: string, secret: string, now: number): string | null {
  const parts = value.split('|');
  if (parts.length !== 4 || parts[0] !== 'v1')
    return null;
  const userId = parts[1];
  const expRaw = parts[2];
  const mac = parts[3];
  if (!userId || !/^\d+$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(mac))
    return null;
  const expiresAt = Number(expRaw);
  if (expiresAt <= now)
    return null;
  const expected = signSessionPayload(secret, userId, expiresAt);
  if (!timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8')))
    return null;
  return userId;
}

function cookieFromHeaders(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers.cookie;
  if (typeof raw !== 'string')
    return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1)
      continue;
    if (part.slice(0, eq).trim() === name)
      return part.slice(eq + 1).trim();
  }
  return null;
}

// -------------------------------------------------------------- small in-memory pieces

/** One-shot redeemable code (same pattern as CliSetupCodes in server/cli-setup.ts). */
class ClaimCodes {
  private readonly codes = new Map<string, number>();

  constructor(private readonly ttlMs: number, private readonly now: () => number) {}

  issue(): string {
    const code = randomBytes(32).toString('hex');
    this.codes.set(code, this.now());
    return code;
  }

  /** Redeem destroys the code (whether expired or not); expired returns false. */
  exchange(code: string): boolean {
    const createdAt = this.codes.get(code);
    if (createdAt === undefined)
      return false;
    this.codes.delete(code);
    return this.now() - createdAt <= this.ttlMs;
  }
}

/** Per-IP sliding-window failure limiter (Fastify req.ip, XFF untrusted by default, anti-spoof). TTL eviction. */
class AttemptLimiter {
  private readonly map = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  allow(ip: string): boolean {
    this.sweep();
    const entry = this.map.get(ip);
    if (!entry)
      return true;
    if (this.now() - entry.windowStart >= this.windowMs)
      return true;
    return entry.count < this.max;
  }

  recordFailure(ip: string): void {
    const now = this.now();
    let entry = this.map.get(ip);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      entry = { count: 0, windowStart: now };
      this.map.set(ip, entry);
    }
    entry.count += 1;
    this.sweep();
  }

  private sweep(): void {
    const now = this.now();
    for (const [ip, entry] of this.map) {
      if (now - entry.windowStart >= this.windowMs)
        this.map.delete(ip);
    }
  }
}

// ------------------------------------------------------------------ provider

export interface PasswordProviderOptions {
  /** sqlite path (factory concatenates from dataDir; connection opens lazily). */
  dbPath: string;
  /** Preset password (env AUTH_PASSWORD): skip claim, persist the hash on first login. For automation. */
  presetPassword?: string;
  serverHost: string;
  serverPort: number;
  /** Public origin (env PUBLIC_ORIGIN): expected value for WS Origin checks; highest priority. */
  publicOrigin?: string;
  /** Server-issued avatar URL (env AUTH_AVATAR_URL template); default '' → frontend initial. */
  avatarUrlFor?: AvatarUrlFor;
  now?: () => number;
}

const PUBLIC_EXACT_PATHS = new Set(['/claim', '/login', '/api/claim', '/api/login']);

export function createPasswordProvider(opts: PasswordProviderOptions): AuthProvider {
  const now = opts.now ?? Date.now;
  const store = new LocalAuthStore(opts.dbPath);
  const claims = new ClaimCodes(CLAIM_TTL_MS, now);
  const limiter = new AttemptLimiter(RATE_MAX_FAILURES, RATE_WINDOW_MS, now);

  /** "Password is available": claim completed, or a preset exists (preset hashes lazily; see /api/login). */
  const claimed = (): boolean => store.hasPassword() || !!opts.presetPassword;

  function sendSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
    const value = buildSessionCookie('owner', now() + SESSION_TTL_MS, store.sessionSecret());
    let cookie
      = `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
    // Secure boundary: PUBLIC_ORIGIN is https, or the reverse proxy declared https (case-insensitive) — either hits.
    // A deploy that only sets PUBLIC_ORIGIN=https and whose proxy does not send XFP still needs a Secure cookie.
    const forwardedProto = headerString(req.headers, 'x-forwarded-proto');
    if (opts.publicOrigin?.startsWith('https://') || forwardedProto?.toLowerCase() === 'https') {
      cookie += '; Secure';
    }
    reply.header('Set-Cookie', cookie);
  }

  return {
    kind: 'password',

    async verify(headers: IncomingHttpHeaders): Promise<VerifiedIdentity | null> {
      const cookie = cookieFromHeaders(headers, COOKIE_NAME);
      if (!cookie)
        return null;
      const userId = parseSessionCookie(cookie, store.sessionSecret(), now());
      return userId ? { userId } : null;
    },

    avatarUrlFor: opts.avatarUrlFor ?? NO_AVATAR,

    forbiddenHtml: GENERIC_FORBIDDEN_HTML,

    isPublicPath(path: string): boolean {
      return PUBLIC_EXACT_PATHS.has(path.split('?')[0] ?? path);
    },

    /**
     * Unauthenticated page GET → 302 to /claim (unset) or /login, **with a next bounce** —
     * CLI `lifeline setup` opening /cli-setup is necessarily unauthenticated; without next the
     * local callback waits out the full 3-minute timeout (found in review). next is consumed only
     * by page JS; open-redirect checks live on the JS side (only same-origin paths starting with
     * `/` and not `//` or `/\`).
     */
    onHttpDenied(req: FastifyRequest, reply: FastifyReply): boolean {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return false;
      const path = (req.url ?? '').split('?')[0] ?? '';
      const lastSegment = path.split('/').pop() ?? '';
      if (path.startsWith('/api/') || lastSegment.includes('.'))
        return false;
      const target = claimed() ? '/login' : '/claim';
      // Fastify v5 onwards: redirect(url, code?) — url first; default code is 302
      reply
        .header('Cache-Control', 'no-store')
        .redirect(`${target}?next=${encodeURIComponent(req.url ?? '/')}`);
      return true;
    },

    /** Cross-site WS handshakes carry the victim's cookie (unprotected by same-origin policy) — Origin must match the expected origin. */
    checkHandshake(headers: IncomingHttpHeaders): string | null {
      return checkOriginAgainstExpected(headers, opts.publicOrigin);
    },

    setupRoutes(app: FastifyInstance): void {
      // First-boot onboarding: no password and no preset → print a one-shot claim code to the console.
      if (!opts.presetPassword && !store.hasPassword()) {
        const code = claims.issue();
        const displayHost
          = opts.serverHost === '0.0.0.0' || opts.serverHost === '::'
            ? '127.0.0.1'
            : opts.serverHost.replace(/^\[|\]$/g, '');
        console.log('');
        console.log('[auth] password provider: no password set yet (first boot).');
        console.log(`[auth] Open http://${displayHost}:${opts.serverPort}/claim and enter this one-time code:`);
        console.log(`[auth]   ${code}`);
        console.log('');
      }

      app.get('/claim', async (req, reply) => {
        if (await this.verify(req.headers))
          return reply.redirect('/');
        return reply.type('text/html').header('Cache-Control', 'no-store').send(CLAIM_HTML);
      });

      app.get('/login', async (req, reply) => {
        if (await this.verify(req.headers))
          return reply.redirect('/');
        if (!claimed())
          return reply.redirect('/claim');
        return reply.type('text/html').header('Cache-Control', 'no-store').send(LOGIN_HTML);
      });

      app.post('/api/claim', async (req, reply) => {
        const ip = req.ip;
        if (!limiter.allow(ip)) {
          return reply.code(429).send({ error: 'Too many attempts; wait a minute and retry.' });
        }
        const body = (req.body ?? {}) as { code?: unknown; password?: unknown };
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        // Check the password before redeeming the code: a wrong password must not burn the claim code.
        if (password.length < MIN_PASSWORD_LEN) {
          limiter.recordFailure(ip);
          return reply.code(400).send({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
        }
        if (!claims.exchange(code)) {
          limiter.recordFailure(ip);
          return reply.code(400).send({ error: 'Invalid or expired code.' });
        }
        await store.setPassword(password);
        sendSessionCookie(req, reply);
        return reply.send({ ok: true });
      });

      app.post('/api/login', async (req, reply) => {
        const ip = req.ip;
        if (!limiter.allow(ip)) {
          return reply.code(429).send({ error: 'Too many attempts; wait a minute and retry.' });
        }
        const body = (req.body ?? {}) as { password?: unknown };
        const password = typeof body.password === 'string' ? body.password : '';
        // Preset password hashes lazily: same scrypt verify path as a password set via claim.
        if (opts.presetPassword && !store.hasPassword()) {
          await store.setPassword(opts.presetPassword);
        }
        if (!password || !(await store.verifyPassword(password))) {
          limiter.recordFailure(ip);
          return reply.code(401).send({ error: 'Invalid password.' });
        }
        sendSessionCookie(req, reply);
        return reply.send({ ok: true });
      });
    },

    close(): void {
      store.close();
    },
  };
}
