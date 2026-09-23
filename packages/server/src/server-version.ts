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

/**
 * Which version this process's server is running = `package.json` version.
 *
 * That is also the number `build:cli` stamps into the CLI and this host publishes as `/cli-latest.txt`,
 * so the page uses it as "latest version" to decide whether a machine's agent is behind.
 *
 * If package.json cannot be read, return 'unknown' — callers must treat unknown as
 * "incomparable", not "oldest", or the UI fills with false update badges.
 */
export function readServerVersion(): string {
  const root = walkForPackage(dirname(fileURLToPath(import.meta.url)));
  if (!root)
    return 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      name?: string;
      version?: string;
    };
    if (pkg.name === 'lifeline' && pkg.version)
      return pkg.version;
  }
  catch {
    /* fall through */
  }
  return 'unknown';
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
