import type { AvatarUrlFor } from './avatar.js';
import type { AuthProvider } from './provider.js';
import { GENERIC_FORBIDDEN_HTML } from '../pages/forbidden-page.js';
import { NO_AVATAR } from './avatar.js';
import { checkOriginAgainstExpected } from './origin.js';

/**
 * Loopback single-user mode: every request is treated as the local owner. Only for loopback binds
 * (factory guard); private-network addresses need explicit AUTH_INSECURE_ALLOW=1 endorsement;
 * public / all-interface binds never get none. verify never fails; forbiddenHtml is only for
 * interface completeness.
 *
 * Handshake still checks Origin: in "local mode", if the owner's browser visits a malicious page,
 * that page can `new WebSocket('ws://127.0.0.1:<port>')` cross-site (CSWSH) and get full owner
 * power — when Origin is present it must match the expected origin (PUBLIC_ORIGIN > Forwarded > Host);
 * CLI shapes with no Origin are still allowed.
 */
export function createNoneProvider(opts?: {
  publicOrigin?: string;
  avatarUrlFor?: AvatarUrlFor;
}): AuthProvider {
  return {
    kind: 'none',
    async verify() {
      return { userId: 'owner' };
    },
    avatarUrlFor: opts?.avatarUrlFor ?? NO_AVATAR,
    forbiddenHtml: GENERIC_FORBIDDEN_HTML,
    checkHandshake(headers) {
      return checkOriginAgainstExpected(headers, opts?.publicOrigin);
    },
  };
}
