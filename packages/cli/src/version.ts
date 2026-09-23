/**
 * CLI version awareness: compare the version baked into the bundle (`__CLI_VERSION__`,
 * injected by scripts/build-cli.ts) against the manifest published next to the
 * runtime tar (`/cli-latest.txt`).
 *
 * Every function here is best-effort: a missing manifest, a login-page intercept, or an
 * unreachable server must all degrade silently (null / 0). A version check must never fail or hang a command.
 */
import { sep } from 'node:path';

/** Filename. Published in the same unauthenticated directory as the runtime tar (see PUBLIC_PREFIX below). */
export const CLI_LATEST_FILE = 'cli-latest.txt';

/**
 * Unauthenticated asset prefix. The server lets `/public/` through via `isPublicPath`
 * (server/public-paths.ts); both sides must match — tests have a cross-assertion on this.
 */
export const PUBLIC_PREFIX = '/public';

/** Manifest body: one x.y.z line; nothing else is accepted. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** First line only; login-page HTML, empty files, and suffixed versions (0.1.52-beta) all return null. */
export function parseVersionText(text: string): string | null {
  const first = (text.split('\n')[0] ?? '').trim();
  return VERSION_RE.test(first) ? first : null;
}

function parts(version: string): number[] {
  return version.split('.').map(n => Number(n));
}

/** Three-segment numeric compare (missing segments pad to 0, invalid segments count as 0); returns -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const y = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (x !== y)
      return x > y ? 1 : -1;
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/** 3s budget: fired in parallel with local probes from `status`; don't stall offline environments. */
export async function fetchLatestVersion(base: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}${PUBLIC_PREFIX}/${CLI_LATEST_FILE}`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok)
      return null;
    return parseVersionText(await res.text());
  }
  catch {
    return null;
  }
}

/** Trailing hint on `status`; returns null when already current (or the server is older). */
export function updateHint(latest: string | null, current: string): string | null {
  if (!latest || !isNewer(latest, current))
    return null;
  return `v${latest} available — run: lifeline update`;
}

/**
 * Is this process an install.sh install (entry under `<home>/runtime/`)?
 * `update` only replaces that kind of install; overlaying an npm / pnpm global install would leave two lifelines fighting over PATH.
 */
export function isBundledRuntimeEntry(entry: string | undefined, home: string): boolean {
  if (!entry)
    return false;
  return entry.startsWith(`${home}${sep}runtime${sep}`);
}
