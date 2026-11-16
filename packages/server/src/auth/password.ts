import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { AvatarUrlFor } from './avatar.js';
import type { AuthProvider, VerifiedIdentity } from './provider.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GENERIC_FORBIDDEN_HTML } from '../pages/forbidden-page.js';
import { AccountStore, AUTH_ERRORS, canonicalUsername, passwordError, passwordProblem } from './accounts.js';
import { NO_AVATAR } from './avatar.js';
import { isLoopbackBindHost } from './bind-host.js';
import { rateLimitKey } from './client-address.js';
import { LocalAuthStore } from './local-auth-store.js';
import { checkOriginAgainstExpected, expectedOrigin, headerString } from './origin.js';
import { loginPage, registerPage, securityHeaders } from './password-pages.js';

const COOKIE_NAME = 'lifeline_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FAILURE_MAX = 5;
const FAILURE_WINDOW_MS = 60 * 1000;
const REGISTER_ATTEMPT_MAX = 30;
const REGISTER_SUCCESS_MAX = 3;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const BODY_LIMIT = 2048;

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

class WindowCounter {
  private readonly map = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** Drop windows that have already elapsed so a rotating address cannot grow the map forever. */
  private prune(now: number): void {
    for (const [key, entry] of this.map) {
      if (now - entry.windowStart >= this.windowMs)
        this.map.delete(key);
    }
  }

  private current(key: string, now: number): { count: number; windowStart: number } | undefined {
    const entry = this.map.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs)
      return undefined;
    return entry;
  }

  allow(key: string): boolean {
    const now = this.now();
    this.prune(now);
    const entry = this.current(key, now);
    if (!entry)
      return true;
    return entry.count < this.max;
  }

  /** Count one event. Callers that still have an `await` ahead must hit before that await. */
  hit(key: string): void {
    const now = this.now();
    this.prune(now);
    let entry = this.current(key, now);
    if (!entry) {
      entry = { count: 0, windowStart: now };
      this.map.set(key, entry);
    }
    entry.count += 1;
  }

  /** Give back a reservation when the outcome must not count (a successful login, a taken name). */
  release(key: string): void {
    const now = this.now();
    this.prune(now);
    const entry = this.current(key, now);
    if (!entry)
      return;
    entry.count -= 1;
    if (entry.count <= 0)
      this.map.delete(key);
  }
}

/** `HTTPS://` and `https://` are the same scheme. A prefix check would disagree with `new URL`. */
export function publicOriginIsHttps(publicOrigin: string | undefined): boolean {
  if (!publicOrigin)
    return false;
  try {
    return new URL(publicOrigin).protocol === 'https:';
  }
  catch {
    return false;
  }
}

/**
 * Scheme and host compared the way the URL parser does, so `HTTPS://Host` matches a browser Origin.
 * A path of `/` is the same as no path. Returns null when the value is not an absolute URL.
 */
function originKey(value: string): string | null {
  try {
    const url = new URL(value);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}${url.search}`;
  }
  catch {
    return null;
  }
}

export function assertHttpsPublicOrigin(serverHost: string, publicOrigin: string | undefined): void {
  if (isLoopbackBindHost(serverHost))
    return;
  let url: URL | null = null;
  try {
    if (publicOrigin)
      url = new URL(publicOrigin);
  }
  catch {
    url = null;
  }
  const pathOk = !!url && (url.pathname === '' || url.pathname === '/');
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !pathOk) {
    throw new Error(
      `password auth on ${serverHost} requires PUBLIC_ORIGIN to be an https origin `
      + `with no userinfo and no path (for example https://lifeline.example.com).`,
    );
  }
}

export interface PasswordProviderOptions {
  dbPath: string;
  serverHost: string;
  serverPort: number;
  publicOrigin?: string;
  /** AUTH_TRUSTED_PROXY=1. Only then may a private/loopback peer supply X-Real-IP. */
  trustedProxy?: boolean;
  /** Unset or anything other than closed means open. */
  registrationOpen?: boolean;
  avatarUrlFor?: AvatarUrlFor;
  now?: () => number;
}

const PUBLIC_EXACT_PATHS = new Set(['/register', '/login', '/api/register', '/api/login']);

/** The marketing page and the files it needs. The console and the API stay behind the cookie. */
function isLandingAsset(path: string): boolean {
  if (path.includes('..'))
    return false;
  if (path === '/' || path === '/favicon.svg')
    return true;
  return path.startsWith('/assets/');
}

function jsonMedia(header: string | undefined): boolean {
  const media = header?.split(';')[0]?.trim().toLowerCase() ?? '';
  return media === 'application/json';
}

function originAllowed(headers: IncomingHttpHeaders, publicOrigin?: string): boolean {
  const origin = headerString(headers, 'origin');
  if (!origin)
    return false;
  const expected = expectedOrigin(headers, publicOrigin);
  if (!expected)
    return false;
  const actualKey = originKey(origin);
  const expectedKey = originKey(expected);
  if (!actualKey || !expectedKey)
    return false;
  return actualKey === expectedKey;
}

function peerOf(req: FastifyRequest): string {
  return req.socket.remoteAddress ?? req.ip ?? '';
}

export function createPasswordProvider(opts: PasswordProviderOptions): AuthProvider {
  assertHttpsPublicOrigin(opts.serverHost, opts.publicOrigin);
  const now = opts.now ?? Date.now;
  const sessions = new LocalAuthStore(opts.dbPath);
  const accounts = new AccountStore(opts.dbPath);
  const failures = new WindowCounter(FAILURE_MAX, FAILURE_WINDOW_MS, now);
  const registerAttempts = new WindowCounter(REGISTER_ATTEMPT_MAX, REGISTER_WINDOW_MS, now);
  const registerSuccesses = new WindowCounter(REGISTER_SUCCESS_MAX, REGISTER_WINDOW_MS, now);
  const registrationOpen = opts.registrationOpen !== false;

  function secureCookie(req: FastifyRequest): boolean {
    if (publicOriginIsHttps(opts.publicOrigin))
      return true;
    return headerString(req.headers, 'x-forwarded-proto')?.toLowerCase() === 'https';
  }

  function setSessionCookie(req: FastifyRequest, reply: FastifyReply, userId: string): void {
    const value = buildSessionCookie(userId, now() + SESSION_TTL_MS, sessions.sessionSecret());
    let cookie = `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
    if (secureCookie(req))
      cookie += '; Secure';
    reply.header('Set-Cookie', cookie);
  }

  function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
    let cookie = `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    if (secureCookie(req))
      cookie += '; Secure';
    reply.header('Set-Cookie', cookie);
  }

  function keyFor(req: FastifyRequest): string {
    return rateLimitKey(peerOf(req), req.headers, !!opts.trustedProxy);
  }

  function failLog(path: string, result: string, key: string): void {
    console.warn(`[auth] ${path} ${result} key=${key}`);
  }

  /** Content-Type and Origin. Returns true when a response was already sent. Does not set a cookie. */
  function rejectCrossSite(req: FastifyRequest, reply: FastifyReply): boolean {
    const type = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
    if (!jsonMedia(type)) {
      reply.code(415).send({ error: 'Content-Type must be application/json.' });
      return true;
    }
    if (!originAllowed(req.headers, opts.publicOrigin)) {
      reply.code(403).send({ error: 'Origin mismatch.' });
      return true;
    }
    return false;
  }

  function sendPage(reply: FastifyReply, html: string, nonce: string): FastifyReply {
    for (const [name, value] of Object.entries(securityHeaders(nonce)))
      reply.header(name, value);
    return reply.type('text/html').send(html);
  }

  return {
    kind: 'password',

    async verify(headers: IncomingHttpHeaders): Promise<VerifiedIdentity | null> {
      const cookie = cookieFromHeaders(headers, COOKIE_NAME);
      if (!cookie)
        return null;
      const userId = parseSessionCookie(cookie, sessions.sessionSecret(), now());
      if (!userId || !accounts.has(userId))
        return null;
      return { userId };
    },

    avatarUrlFor: opts.avatarUrlFor ?? NO_AVATAR,

    forbiddenHtml: GENERIC_FORBIDDEN_HTML,

    isPublicPath(path: string): boolean {
      const bare = path.split('?')[0] ?? path;
      return PUBLIC_EXACT_PATHS.has(bare) || isLandingAsset(bare);
    },

    /**
     * Unauthenticated page GET → 302 to /login, with a next bounce.
     * CLI `lifeline setup` opening /cli-setup is necessarily unauthenticated; without next the
     * local callback waits out the full 3-minute timeout. next is consumed only by page JS.
     */
    onHttpDenied(req: FastifyRequest, reply: FastifyReply): boolean {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return false;
      const path = (req.url ?? '').split('?')[0] ?? '';
      const lastSegment = path.split('/').pop() ?? '';
      if (path.startsWith('/api/') || lastSegment.includes('.'))
        return false;
      reply
        .header('Cache-Control', 'no-store')
        .redirect(`/login?next=${encodeURIComponent(req.url ?? '/')}`);
      return true;
    },

    checkHandshake(headers: IncomingHttpHeaders): string | null {
      return checkOriginAgainstExpected(headers, opts.publicOrigin);
    },

    setupRoutes(app: FastifyInstance): void {
      if (!registrationOpen && accounts.count() === 0) {
        console.warn('[auth] registration is closed and there are no accounts; nobody can sign in.');
      }

      app.get('/login', async (req, reply) => {
        if (await this.verify(req.headers))
          return reply.redirect('/');
        const nonce = randomBytes(16).toString('base64url');
        return sendPage(reply, loginPage(nonce, registrationOpen), nonce);
      });

      app.get('/register', async (req, reply) => {
        if (await this.verify(req.headers))
          return reply.redirect('/');
        if (!registrationOpen)
          return reply.header('Cache-Control', 'no-store').redirect('/login');
        const nonce = randomBytes(16).toString('base64url');
        return sendPage(reply, registerPage(nonce), nonce);
      });

      app.post('/api/register', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
        if (rejectCrossSite(req, reply))
          return;
        const key = keyFor(req);
        if (!registrationOpen) {
          return reply.code(403).send({ error: AUTH_ERRORS.closed });
        }
        if (!failures.allow(key) || !registerAttempts.allow(key) || !registerSuccesses.allow(key)) {
          failLog('/api/register', '429', key);
          return reply.code(429).send({ error: AUTH_ERRORS.limited });
        }
        const body = (req.body ?? {}) as { username?: unknown; password?: unknown; passwordConfirm?: unknown };
        const usernameRaw = typeof body.username === 'string' ? body.username : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const confirm = typeof body.passwordConfirm === 'string' ? body.passwordConfirm : '';
        const username = canonicalUsername(usernameRaw);
        if (!username) {
          failures.hit(key);
          registerAttempts.hit(key);
          failLog('/api/register', '400', key);
          return reply.code(400).send({ error: AUTH_ERRORS.username });
        }
        if (password !== confirm) {
          failures.hit(key);
          registerAttempts.hit(key);
          failLog('/api/register', '400', key);
          return reply.code(400).send({ error: AUTH_ERRORS.passwordMismatch });
        }
        const problem = passwordProblem(password, username);
        if (problem) {
          failures.hit(key);
          registerAttempts.hit(key);
          failLog('/api/register', '400', key);
          return reply.code(400).send({ error: passwordError(problem) });
        }
        // Reserve before scrypt. A parallel burst otherwise all see the old count and all proceed.
        // Success does not count as a failure. A taken name is not a successful registration.
        registerAttempts.hit(key);
        registerSuccesses.hit(key);
        failures.hit(key);
        const created = await accounts.create(username, password);
        if (created === 'taken') {
          registerSuccesses.release(key);
          failLog('/api/register', '409', key);
          return reply.code(409).send({ error: AUTH_ERRORS.taken });
        }
        failures.release(key);
        setSessionCookie(req, reply, username);
        return reply.send({ ok: true });
      });

      app.post('/api/login', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
        if (rejectCrossSite(req, reply))
          return;
        const key = keyFor(req);
        if (!failures.allow(key)) {
          failLog('/api/login', '429', key);
          return reply.code(429).send({ error: AUTH_ERRORS.limited });
        }
        const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
        const username = typeof body.username === 'string' ? canonicalUsername(body.username) : null;
        const password = typeof body.password === 'string' ? body.password : '';
        if (password.length > 128) {
          failures.hit(key);
          failLog('/api/login', '400', key);
          return reply.code(400).send({ error: AUTH_ERRORS.passwordLong });
        }
        // Reserve before scrypt. A correct password gives the slot back, so success does not count.
        failures.hit(key);
        const ok = await accounts.verify(username, password);
        if (!ok) {
          failLog('/api/login', '401', key);
          return reply.code(401).send({ error: AUTH_ERRORS.login });
        }
        failures.release(key);
        setSessionCookie(req, reply, username!);
        return reply.send({ ok: true });
      });

      app.post('/api/logout', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
        if (rejectCrossSite(req, reply))
          return;
        clearSessionCookie(req, reply);
        return reply.send({ ok: true });
      });
    },

    close(): void {
      accounts.close();
      sessions.close();
    },
  };
}
