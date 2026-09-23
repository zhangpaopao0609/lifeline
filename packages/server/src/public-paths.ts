import { posix } from 'node:path';

/**
 * Auth exemption zone (independent of login method / provider). Three rules, each matching one auth model:
 *
 * - `/public/*` — artifacts distributed to unauthenticated machines: install.sh / runtime tarball / version
 *   manifest (no credentials), plus `cli-setup/exchange` which carries its own one-shot code. Consumers are
 *   curl and the CLI; they have no identity header. Physical dir is dist/client/public, mounted at this
 *   prefix by relay.ts.
 * - `/healthz` — ops liveness convention (`lifeline status`, load balancers, container healthcheck).
 * - `/agent-io` — agent's Socket.IO channel; handshake separately verifies the personal token issued at
 *   enroll time (agent-hub.ts).
 *
 * Every other path requires identity (pages, page static assets, `/api/*`). A provider may layer extra
 * exemptions via `AuthProvider.isPublicPath` (password's /login, /claim — exact paths). If something new
 * is not one of these three, do not add it here — enumerating paths one by one is exactly what this
 * function exists to stop.
 *
 * Normalize-to-block-bypass (decode then normalize, reject backslashes) is a hard constraint here: tests
 * are in tests/public-paths.test.ts; those assertions must not change line-by-line.
 */
export function isPublicPath(path: string): boolean {
  const raw = (path.split('?')[0] ?? path) || path;
  // Decode first, then normalize — neither step is optional: `/public/%2e%2e/index.html` must decode to `..`
  // before normalize can strip it. Skip either step and it sails through still prefixed with /public/, while
  // the downstream static file server will decode on its own and serve clientDir/index.html as-is.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  }
  catch {
    return false; // malformed percent-encoding: don't guess; treat as "needs auth"
  }
  const p = posix.normalize(decoded);
  // Backslash is an ordinary character on posix, but on Windows a static file server would treat it as a
  // separator — a prefix-bypass side channel. Block it here, independent of the deploy platform.
  if (p.includes('\\') || p.includes('\0'))
    return false;
  if (p.startsWith('/public/'))
    return true;
  if (p === '/healthz')
    return true;
  return p === '/agent-io' || p.startsWith('/agent-io/');
}
