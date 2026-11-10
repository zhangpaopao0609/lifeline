import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function walkForPackage(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'lifeline' && pkg.version)
        return dir;
    }
    catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}

/** Repo root (directory of the product package.json named `lifeline`). */
export function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  return walkForPackage(from) ?? from;
}

interface VersionFields {
  version?: string;
  cliVersion?: string;
}

function readVersionFields(): VersionFields {
  const root = walkForPackage(dirname(fileURLToPath(import.meta.url)));
  if (!root)
    return {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as VersionFields & { name?: string };
    if (pkg.name === 'lifeline')
      return { version: pkg.version, cliVersion: pkg.cliVersion };
  }
  catch {
    /* fall through */
  }
  return {};
}

/**
 * The **product version** this process's server is running (banner, support reports).
 *
 * Not the update signal: that is `readCliVersion`. Separate because the two move on different schedules —
 * the product version follows a release (a batch of user-visible changes), the CLI version follows a real
 * change to the machine-side artifact (docs/release.md).
 *
 * If package.json cannot be read, return 'unknown' — callers must treat unknown as
 * "incomparable", not "oldest", or the UI fills with false update badges.
 */
export function readServerVersion(): string {
  return readVersionFields().version ?? 'unknown';
}

/**
 * The **machine-side** version (CLI + agent): what `build:cli` bakes in and publishes as `/cli-latest.txt`,
 * and what the page receives as `cliLatest` to decide whether a machine's agent is behind.
 *
 * Must stay tied to that artifact, never to the product release: bumping it for a web-only change tells every
 * machine to pull an identical agent (and lights 「可更新」 for nothing).
 *
 * Falls back to the product version for checkouts that predate the split.
 */
export function readCliVersion(): string {
  const fields = readVersionFields();
  return fields.cliVersion ?? fields.version ?? 'unknown';
}

export function clientDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
  const root = repoRoot(from);
  const built = join(root, 'dist', 'client');
  const web = join(root, 'packages', 'web');
  if (existsSync(join(built, 'index.html')) || existsSync(join(built, 'public', 'install.sh'))) {
    return built;
  }
  if (existsSync(join(web, 'public', 'install.sh')))
    return web;
  return built;
}
