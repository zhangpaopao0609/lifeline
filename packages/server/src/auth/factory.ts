import type { ServerConfig } from '../types.js';
import type { AvatarUrlFor } from './avatar.js';
import type { AuthProvider, AuthProviderKind } from './provider.js';
import { join } from 'node:path';
import { LIFELINE_DB_FILE } from '../db/open.js';
import { avatarUrlResolver } from './avatar.js';
import { isLoopbackBindHost, isPrivateBindHost } from './bind-host.js';
import { createNoneProvider } from './none.js';
import { createPasswordProvider } from './password.js';
import { createTrustedHeaderProvider } from './trusted-header.js';

export { isLoopbackBindHost, isPrivateBindHost };

const EXPLICIT_KINDS: readonly AuthProviderKind[] = ['trusted-header', 'password', 'none'];

export const LEGACY_PASSWORD_ERROR
  = 'AUTH_PASSWORD is no longer used. Remove it. Create an account at /register, and set AUTH_REGISTRATION=0 to close sign-up.';

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
    serverHost: config.serverHost,
    serverPort: config.serverPort,
    publicOrigin: config.publicOrigin,
    trustedProxy: config.authTrustedProxy,
    registrationOpen: config.authRegistrationOpen !== false,
    avatarUrlFor,
  });
}

/**
 * Assembly priority:
 *
 *     AUTH_PROVIDER explicit > AUTH_HEADER > loopback→none > password accounts
 *
 * - AUTH_PASSWORD is rejected. It used to select a single shared password.
 * - Non-loopback (including 0.0.0.0) with no config → password accounts, which themselves
 *   require PUBLIC_ORIGIN to be https.
 * - none never lands on a public / all-interface bind (guardNone).
 */
export function createAuthProvider(config: ServerConfig): AuthProvider {
  if (config.authPassword?.trim())
    throw new Error(LEGACY_PASSWORD_ERROR);
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
  const none = guardNone(config, avatarUrlFor);
  if (none)
    return none;
  return passwordProvider(config, avatarUrlFor);
}
