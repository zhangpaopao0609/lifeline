/**
 * Version compare: whether a machine's agent (CLI) is behind the version the server published.
 *
 * Rules match compareVersions in the server's `src/cli/version.ts` — web is a separate
 * subproject (its own tsconfig/deps) and cannot import across directories, so this is a minimal replica.
 */

function parseVersion(text: string | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec((text ?? '').trim());
  if (!m)
    return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Both sides must be real version numbers: older agents omit version, the server can't read
 * package.json ('unknown'), local dev (0.0.0-dev) all return false — better to say nothing
 * than to wrongly flag "update available".
 */
export function isOutdated(cliVersion: string | undefined, latest: string | undefined): boolean {
  const cli = parseVersion(cliVersion);
  const server = parseVersion(latest);
  if (!cli || !server)
    return false;
  for (let i = 0; i < 3; i++) {
    if (server[i] !== cli[i])
      return server[i]! > cli[i]!;
  }
  return false;
}
