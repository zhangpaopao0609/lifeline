import type { ServerConfig } from '../types.js';
import type { AvatarUrlFor } from './avatar.js';
import type { AuthProvider, AuthProviderKind } from './provider.js';
import { join } from 'node:path';
import { LIFELINE_DB_FILE } from '../db/open.js';
import { avatarUrlResolver } from './avatar.js';
import { createNoneProvider } from './none.js';
import { createPasswordProvider } from './password.js';
import { createTrustedHeaderProvider } from './trusted-header.js';

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const EXPLICIT_KINDS: readonly AuthProviderKind[] = ['trusted-header', 'password', 'none'];

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase());
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4)
    return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part))
      return null;
    const n = Number(part);
    if (n > 255)
      return null;
    octets.push(n);
  }
  return octets;
}

/** IPv6 ULA (fc00::/7, i.e. fc** / fd** prefix). link-local (fe80::/10) does not count. */
function isIpv6Ula(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!bare.includes(':'))
    return false;
  const first = bare.split(':')[0] ?? '';
  if (!/^[0-9a-f]{1,4}$/.test(first))
    return false; // '::' → first group empty → all-interfaces, not ULA
  return (Number.parseInt(first, 16) & 0xFE00) === 0xFC00;
}

/**
 * Bind addresses "not worth trusting by default, but may run bare with explicit AUTH_INSECURE_ALLOW=1":
 * loopback, RFC1918 private, Tailscale CGNAT (100.64/10), IPv6 ULA (fc00::/7).
 * `0.0.0.0` / `::` are all-interface binds (including the public internet) and never count as private;
 * IPv6 other than loopback / ULA is treated as public (conservative). Note Docker `-p` can map
 * container-internal loopback onto the public internet — this layer cannot catch that (auth matrix is
 * in the repo-root .env.example).
 */
export function isPrivateBindHost(host: string): boolean {
  if (isLoopbackBindHost(host))
    return true;
  const bare = host.trim().replace(/^\[|\]$/g, '');
  if (bare === '::')
    return false;
  if (isIpv6Ula(bare))
    return true;
  const octets = ipv4Octets(bare);
  if (!octets)
    return false;
  const [a, b] = octets;
  if (a === 10)
    return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31)
    return true; // 172.16/12
  if (a === 192 && b === 168)
    return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127)
    return true; // CGNAT 100.64/10 (Tailscale)
  return false;
}

function createNone(config: ServerConfig, avatarUrlFor: AvatarUrlFor): AuthProvider {
  return createNoneProvider({ publicOrigin: config.publicOrigin, avatarUrlFor });
}

function warnUnauthenticated(host: string): void {
  console.warn(
    `[auth] WARNING: running unauthenticated (none) on ${host} — `
    + `anyone who can reach this address can read your sessions and send commands.`,
  );
}

/** Placement guard for none (same rule for auto and explicit): loopback allowed; private needs ALLOW; public / all-interface never. */
function guardNone(config: ServerConfig, avatarUrlFor: AvatarUrlFor): AuthProvider | null {
  const host = config.serverHost;
  if (isLoopbackBindHost(host))
    return createNone(config, avatarUrlFor);
  if (isPrivateBindHost(host) && config.authInsecureAllow) {
    warnUnauthenticated(host);
    return createNone(config, avatarUrlFor);
  }
  return null;
}

function refuseExplicitNone(host: string): never {
  throw new Error(
    `AUTH_PROVIDER=none refuses to bind ${host}: loopback needs no flag, `
    + `private addresses need AUTH_INSECURE_ALLOW=1, `
    + `public / all-interface addresses need a real provider (AUTH_HEADER / password).`,
  );
}

/** Placement guard for trusted-header: non-loopback must explicitly acknowledge "I sit behind a gateway". */
function guardTrustedHeader(config: ServerConfig, avatarUrlFor: AvatarUrlFor): AuthProvider {
  const headerName = config.authHeaderName ?? '';
  if (!headerName) {
    throw new Error('AUTH_PROVIDER=trusted-header requires AUTH_HEADER');
  }
  if (isLoopbackBindHost(config.serverHost)) {
    return createTrustedHeaderProvider(headerName, avatarUrlFor);
  }
  if (!config.authTrustedProxy) {
    throw new Error(
      `AUTH_HEADER on a non-loopback bind (${config.serverHost}) can be spoofed by any client `
      + `that connects directly. Put a gateway in front that strips the header, then set `
      + `AUTH_TRUSTED_PROXY=1 to acknowledge it (or bind SERVER_HOST=127.0.0.1).`,
    );
  }
  console.warn(
    `[auth] WARNING: trusting client-reachable header "${headerName}" for identity on `
    + `${config.serverHost}. Make sure your gateway strips this header from client requests.`,
  );
  return createTrustedHeaderProvider(headerName, avatarUrlFor);
}

function passwordProvider(config: ServerConfig, avatarUrlFor: AvatarUrlFor): AuthProvider {
  // dbPath is only concatenated here; the disk is not touched (openSqlite's mkdir is lazy until first use).
  return createPasswordProvider({
    dbPath: join(config.dataDir, LIFELINE_DB_FILE),
    presetPassword: config.authPassword || undefined,
    serverHost: config.serverHost,
    serverPort: config.serverPort,
    publicOrigin: config.publicOrigin,
    avatarUrlFor,
  });
}

/**
 * Assembly priority (frozen; see spec):
 *
 *     AUTH_PROVIDER explicit > AUTH_HEADER > AUTH_PASSWORD
 *       > loopback→none > password
 *
 * - loopback + AUTH_PASSWORD → password (not none).
 * - Non-loopback (including 0.0.0.0) with no config → password (claim onboarding); do not refuse to start.
 * - none never lands on a public / all-interface bind (guardNone).
 */
export function createAuthProvider(config: ServerConfig): AuthProvider {
  // Parse the avatar template once here: throw immediately if the format is wrong (missing {userId}), don't wait until the first user:info.
  const avatarUrlFor = avatarUrlResolver(config.authAvatarUrl);
  const explicit = config.authProviderName?.trim();
  if (explicit) {
    const kind = EXPLICIT_KINDS.find(k => k === explicit);
    if (!kind) {
      throw new Error(
        `Unknown AUTH_PROVIDER "${explicit}" (expected one of: ${EXPLICIT_KINDS.join(', ')})`,
      );
    }
    switch (kind) {
      case 'trusted-header':
        return guardTrustedHeader(config, avatarUrlFor);
      case 'password':
        return passwordProvider(config, avatarUrlFor);
      case 'none': {
        const provider = guardNone(config, avatarUrlFor);
        if (provider)
          return provider;
        refuseExplicitNone(config.serverHost);
      }
    }
  }
  if (config.authHeaderName)
    return guardTrustedHeader(config, avatarUrlFor);
  if (config.authPassword)
    return passwordProvider(config, avatarUrlFor);
  const none = guardNone(config, avatarUrlFor);
  if (none)
    return none;
  return passwordProvider(config, avatarUrlFor);
}
