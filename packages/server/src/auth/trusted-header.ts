import type { IncomingHttpHeaders } from 'node:http';
import type { AvatarUrlFor } from './avatar.js';
import type { AuthProvider, VerifiedIdentity } from './provider.js';
import { GENERIC_FORBIDDEN_HTML } from '../pages/forbidden-page.js';
import { NO_AVATAR } from './avatar.js';

const MAX_USER_ID_LENGTH = 128;

/**
 * Gateway-injected plaintext user-header mode: Cloudflare Access (Cf-Access-Authenticated-User-Email),
 * Authelia / authentik (Remote-User), nginx auth_request (X-Auth-Request-User), etc.
 * The gateway owns the login page; we only trust the header — a value is identity, no value is reject.
 *
 * A valued header is identity ⇒ a client that can reach the server can spoof it. Factory guard: non-loopback
 * binds must set AUTH_TRUSTED_PROXY=1 (the gateway must strip a same-named header the client sent).
 * The header value is used only as userId and is never echoed into any HTML (the forbidden page is static copy).
 */
export function createTrustedHeaderProvider(
  headerName: string,
  avatarUrlFor: AvatarUrlFor = NO_AVATAR,
): AuthProvider {
  const name = headerName.trim().toLowerCase();
  if (!name) {
    throw new Error('AUTH_HEADER must name the header that carries the username');
  }
  return {
    kind: 'trusted-header',
    async verify(headers: IncomingHttpHeaders): Promise<VerifiedIdentity | null> {
      const raw = headers[name];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value !== 'string')
        return null;
      const userId = value.trim();
      if (!userId || userId.length > MAX_USER_ID_LENGTH)
        return null;
      return { userId };
    },
    avatarUrlFor,
    forbiddenHtml: GENERIC_FORBIDDEN_HTML,
  };
}
